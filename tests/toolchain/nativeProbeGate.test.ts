import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { realLibuvcpp, skipReason } from "../support/realLibuvcpp.js";

/**
 * The probe's HTTP/3 build gate, run for real: three install trees, three answers.
 *
 * `native/uvcpp-probe` compiles its HTTP/3 exchange only when the install it is
 * pointed at exposes the HTTP/3 C ABI — without that gate the WebSocket half loses
 * its native stack on every libuvcpp built without HTTP3, for a reason that has
 * nothing to do with WebSocket. The gate lives in CMake, which is script with no
 * compiler behind it, so the only test that means anything runs a real CMake
 * against real trees of headers. Three of them, because there are three answers and
 * two of them are easy to conflate:
 *
 *   - the install as it is — HTTP/3 on — builds the exchange;
 *   - an install configured with `-DUVCPP_ENABLE_HTTP3=OFF` does not, and the probe
 *     is still built, complete for WebSocket;
 *   - an install whose config header enables HTTP/3 while the header it names is
 *     not there is a contradiction the gate names, because in that tree *no*
 *     translation unit compiles — `main.cpp` includes the umbrella header whatever
 *     exchange is being built — and the honest ending is one sentence about the
 *     install rather than a compiler cascade through a header nobody asked for.
 *
 * **What is real, and what is not.** Real: CMake, the compiler, the probe's own
 * `CMakeLists.txt`, and the configure and build of the third case, whose binary is
 * run and asked for its exchange list. Modelled: the second and third trees are
 * copies of the install's `include/` directory with a generated config header
 * rewritten to the shape libuvcpp's generator emits for a module that is off. That
 * header is the thing the gate reads, so rewriting it is the honest way to make an
 * install this host does not have — and it is stated here rather than implied,
 * because an install tree that was never configured by libuvcpp is not evidence
 * about libuvcpp's generator. One thing deliberately left alone in the second tree:
 * QUIC stays on. `UVCPP_ENABLE_QUIC=ON -DUVCPP_ENABLE_HTTP3=OFF` is a real
 * configuration (HTTP/3 needs QUIC, not the other way round), and the gate does not
 * read it.
 */

const REPOSITORY = resolve(import.meta.dirname, "..", "..");
const PROBE_SOURCE = join(REPOSITORY, "native", "uvcpp-probe");

/** The path CMake resolves `capi/uvcpp_c_http3.h` through, and the file removed. */
const H3_HEADER = join("capi", "uvcpp_c_http3.h");

/** The generated config header, whose HTTP/3 block the models rewrite. */
const CONFIG_HEADER = join("uvcpp", "uvcpp_config.h");

const run = async (
  command: string,
  args: readonly string[],
): Promise<{ code: number | null; output: string }> =>
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, output });
    });
  });

/** Whether this host has a CMake at all, asked of CMake rather than of `PATH`. */
const cmake = await run("cmake", ["--version"])
  .then((outcome) => (outcome.code === 0 ? "cmake" : undefined))
  .catch(() => undefined);

/**
 * Why this file is skipped, or `""` to run it.
 *
 * Each condition is named separately, because each has a different fix and a lane
 * that named the wrong one would send a reader to the wrong file. The library path
 * is not searched for: deriving it from the install's own prefix keeps one answer to
 * "where does libuvcpp live on this host", and a second search order here could pick
 * a library the real lanes are not using.
 */
const library = realLibuvcpp === undefined ? "" : join(realLibuvcpp.prefix, "lib", "libuvcpp.so");

const guard =
  realLibuvcpp === undefined
    ? skipReason
    : cmake === undefined
      ? "no `cmake` on this host, so the probe's build gate cannot be run"
      : !existsSync(library)
        ? `the libuvcpp install at ${realLibuvcpp.prefix} has no lib/libuvcpp.so to link the probe against`
        : "";

const scratch = await realpath(await mkdtemp(join(tmpdir(), "uvp-probe-gate-")));

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/**
 * A copy of this install's headers with HTTP/3 turned off the way a configure would.
 *
 * The block replaced is the one libuvcpp's generator emits for a switch: a guard
 * that refuses a definition disagreeing with the build, then a default. Rewriting it
 * to the `0` form is a model of the generated file, not a build of libuvcpp — see the
 * file's header. The rewrite asserts it changed something, so a future libuvcpp whose
 * header is shaped differently fails here instead of producing a tree that silently
 * tests the wrong thing.
 */
const configHeaderWithHttp3Off = (header: string): string => {
  const name = "UVCPP_HTTP3_ENABLE";
  const on = [
    `#if defined(${name}) && (${name} != 1)`,
    `#  error "${name}=1 in this build; remove your own definition of it"`,
    "#endif",
    `#ifndef ${name}`,
    `#  define ${name} 1`,
    "#endif",
  ].join("\n");
  const off = [
    `#if defined(${name}) && (${name} != 0)`,
    `#  error "${name}=0 in this build; remove your own definition of it"`,
    "#endif",
    `#ifndef ${name}`,
    `#  define ${name} 0`,
    "#endif",
  ].join("\n");
  return header.replace(on, off);
};

/** One copy of the install's headers, with `mutate` applied to it. */
const treeOf = async (
  name: string,
  mutate: (include: string) => Promise<void>,
): Promise<string> => {
  const include = join(scratch, name, "include");
  await cp(join(realLibuvcpp?.prefix ?? "", "include"), include, { recursive: true });
  await mutate(include);
  return include;
};

/**
 * CMake's output with its line breaks flattened, for reading a sentence out of it.
 *
 * CMake wraps `message()` at the terminal width, so a sentence longer than a line
 * arrives split across two of them — and with the two-space indent it puts in front
 * of a continuation line sitting in the middle of the sentence. Matching against the
 * raw output would therefore pass or fail on the *length of the include path* in the
 * message, which is not what any of these tests are about.
 */
const asOneLine = (output: string): string => output.replace(/\s+/gu, " ");

/** Configure the probe against one include tree, and say what CMake decided. */
const configure = async (
  name: string,
  include: string,
): Promise<{ code: number | null; output: string; build: string }> => {
  const build = join(scratch, name, "build");
  const outcome = await run(cmake ?? "cmake", [
    "-S",
    PROBE_SOURCE,
    "-B",
    build,
    `-DUVCPP_INCLUDE_DIR=${include}`,
    `-DUVCPP_LIBRARY=${library}`,
  ]);
  return { ...outcome, build };
};

describe.skipIf(guard !== "")(
  guard === ""
    ? "the probe's HTTP/3 build gate"
    : `the probe's HTTP/3 build gate — skipped: ${guard}`,
  () => {
    it("builds the exchange against the install as it is", async () => {
      const include = join(realLibuvcpp?.prefix ?? "", "include");
      const configured = await configure("as-installed", include);
      expect(configured.code, configured.output).toBe(0);
      expect(asOneLine(configured.output)).toContain("has the HTTP/3 C ABI");
    }, 120_000);

    it("leaves the probe buildable, and the WebSocket exchange intact, without HTTP/3", async () => {
      const include = await treeOf("http3-off", async (root) => {
        await rm(join(root, H3_HEADER));
        const path = join(root, CONFIG_HEADER);
        const header = await readFile(path, "utf8");
        const rewritten = configHeaderWithHttp3Off(header);
        expect(rewritten, "the config header was not the shape this model rewrites").not.toBe(
          header,
        );
        await writeFile(path, rewritten);
      });

      const configured = await configure("http3-off", include);
      expect(configured.code, configured.output).toBe(0);
      expect(asOneLine(configured.output)).toContain("has no HTTP/3 C ABI");

      // The claim the row is about, and the reason this test builds rather than
      // stops at configure: what the gate buys is a probe binary. Its own
      // `--version` is where the answer has to be read, because that is where a
      // caller reads it.
      const built = await run("cmake", ["--build", configured.build]);
      expect(built.code, built.output).toBe(0);
      const binary = join(configured.build, "uvcpp-probe");
      const version = await run(binary, ["--version"]);
      expect(version.code, version.output).toBe(0);
      const report = JSON.parse(version.output) as {
        exchanges: string[];
        unavailable_exchanges: Record<string, string>;
      };
      expect(report.exchanges).toEqual(["websocket"]);
      // A reason rather than a bare absence: the remedy is a different install, and
      // a caller who saw only a gap in the list would repeat this build instead.
      expect(report.unavailable_exchanges["http3"]).toContain("did not expose the HTTP/3 C ABI");
    }, 300_000);

    it("refuses to build anything against an install that contradicts itself", async () => {
      // The config header still enables HTTP/3 and its header is gone. Both halves
      // are a real thing to find: a packager that moved a file, an install that was
      // copied without one. Every translation unit of the probe includes the
      // umbrella header, so this is not a missing exchange — it is an install no
      // exchange can be built against, and the gate says so in one line.
      const include = await treeOf("contradictory", async (root) => {
        await rm(join(root, H3_HEADER));
      });
      const configured = await configure("contradictory", include);
      expect(configured.code).not.toBe(0);
      const said = asOneLine(configured.output);
      // The gate's own sentence, and the half of it that decides what the reader
      // does next: the fix is the install, not this build. A gate that only said
      // "HTTP/3 is missing" here would be describing the symptom — the thing that
      // is missing is not a module, it is a consistent install.
      expect(said).toContain("does not compile on its own");
      expect(said).toContain("reinstall libuvcpp so its headers match its generated config header");
      // And the consequence that matters to a caller: no binary was produced for
      // anyone to run. If a future CMake let this configure through, the assertion
      // above would still pass on the message while a half-built probe sat there.
      expect(existsSync(join(configured.build, "uvcpp-probe"))).toBe(false);
    }, 120_000);
  },
);
