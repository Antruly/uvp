import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { EXIT_NO, EXIT_OK } from "../../src/cli/exitCodes.js";
import { parseUvpError } from "../../src/domain/errors.js";
import {
  buildWorkspace,
  cleanup,
  createWorkspace,
  realLibuvcpp,
  resultOrThrow,
  runCli,
  skipReason,
} from "../support/realLibuvcpp.js";

/**
 * What a build that fails says about it.
 *
 * `realToolchain` proves the five templates do what they promise; this file
 * proves the other half of the same claim, which is that a failure is *reported*
 * as one. Both halves matter to the same caller for the same reason: an agent
 * that cannot see why a workspace did not build has nothing to act on, and the
 * difference between "the workspace is broken", "the library is missing", and
 * "this tool could not tell" is the difference between three next steps.
 *
 * Two failures are exercised, one per phase, because different programs produce
 * them and they behaved differently:
 *
 * - **A compile failure**, produced by the compiler. Its diagnostics are GCC's,
 *   which the toolchain layer has always parsed; this file holds that parsing
 *   still works through the whole chain — `uvp build` as a process, not the parser
 *   directly, which `src/toolchains/diagnostics.test.ts` covers.
 * - **A configure failure**, produced by CMake itself. CMake's errors are not
 *   compiler diagnostics in any spelling, and the parser knew only the compiler
 *   formats: a configure failure came back as `succeeded: false`,
 *   `compile_duration_ms: 0`, and **`diagnostics: []`**, under a limitation that
 *   promised "the diagnostics below are the compiler's own output". Both halves of
 *   that were wrong — there were no diagnostics below, and a configure failure was
 *   never going to produce the compiler's output anyway.
 * - **A link failure**, produced by `ld` through the compiler driver. This was the
 *   last of the three with no format, and the phase the contract has for it —
 *   `link` — had no producer at all: the linker's lines carry no file, no line and
 *   no column, so every format in the parser passed them by, and a link failure
 *   came back as a build that failed with nothing to act on. A compiler that
 *   failed to *link* is a different next step from one that failed to compile, so
 *   the test below asserts the phase as well as the words.
 *
 * The link failure is also where the environment the build runs in became part of
 * the parser: `ld` and GNU Make translate their messages, so on a host whose
 * locale is not English the linker's complaint is one no format here matches —
 * measured on this host, and covered by the second link test below.
 *
 * A third thing a failing build can lead to is a launch, and the last test here
 * covers the join: a workspace that failed to build has nothing to run, and
 * `uvp run` must say so rather than report a service.
 *
 * The workspace is a **generated** one that is then broken, rather than a
 * hand-written CMake project: the question is what uvp says about a workspace it
 * produced itself, and a hand-written fixture could differ from a template in ways
 * that matter — the CMake floor, the C++ standard, the libuvcpp inquiry — without
 * anyone noticing.
 */

/** The line inserted into a generated `main.cpp` to break it. */
const BROKEN_LINE = "  this is not c++;";

/** Where it goes: the first line of `main`'s body. */
const MAIN_ANCHOR = /^int main\(\)\s*\{/u;

/**
 * The line appended to a generated `CMakeLists.txt` to break the configure.
 *
 * A command CMake does not have, rather than an edit to one of the template's
 * own: the failure is then unambiguous — CMake stops on this line, and the
 * diagnostic should name it — where a mistyped `find_package` would fail
 * somewhere else and prove less about the location.
 */
const BROKEN_CMAKE_LINE = "not_a_real_cmake_command()";

/**
 * The 1-based line whose trimmed text is `text`, read back from the file.
 *
 * Read back rather than written down here: a template that grows a line of
 * preamble would otherwise turn these tests red for a reason that has nothing to
 * do with diagnostics, and the claim being tested is "the diagnostic points at
 * the line that is broken", not "the template has not changed". Comparison is on
 * trimmed text, so the fixture's indentation does not have to be repeated here.
 */
const lineOf = (path: string, text: string): number => {
  const wanted = text.trim();
  const found =
    readFileSync(path, "utf8")
      .split("\n")
      .findIndex((line) => line.trim() === wanted) + 1;
  if (found === 0) throw new Error(`no line \`${wanted}\` in ${path}`);
  return found;
};

/**
 * Break a generated workspace's source **inside `main`**, after the opening brace.
 *
 * Inside `main` and not at the top of the file, because the two are different
 * errors: at file scope GCC says "expected unqualified-id before ‘this’", and
 * inside a non-member function it says "invalid use of ‘this’ in non-member
 * function". The assertion below is that the diagnostic carries the *compiler's
 * own* words, so the fixture has to fix which words those are.
 */
const breakSource = (workspace: { readonly root: string }): void => {
  const path = join(workspace.root, "src", "main.cpp");
  const lines = readFileSync(path, "utf8").split("\n");
  const anchor = lines.findIndex((line) => MAIN_ANCHOR.test(line));
  if (anchor < 0) throw new Error(`no \`int main() {\` in ${path} to break`);
  lines.splice(anchor + 1, 0, BROKEN_LINE);
  writeFileSync(path, lines.join("\n"));
};

/** Break a generated workspace's configure, at the end, where CMake reads it. */
const breakConfigure = (workspace: { readonly root: string }): void => {
  const path = join(workspace.root, "CMakeLists.txt");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n${BROKEN_CMAKE_LINE}\n`);
};

/**
 * The symbol a link failure is made from: declared, called, and never defined.
 *
 * A *definition* is what has to be missing, so the compile has to succeed — a call
 * to an undeclared name is a compile error, which is the case the first test above
 * already covers and would prove nothing about linking. With the declaration in
 * place the translation unit is valid and the failure belongs to the link, and the
 * call site is what lets the linker name a place in the caller's own source, which
 * is the half of a link failure a caller acts on.
 *
 * `extern "C"` is deliberately not used: the name below is a C++ one, so what the
 * linker prints is a demangled symbol, which is the shape the format in
 * `src/toolchains/diagnostics.ts` was captured from.
 */
const ABSENT_SYMBOL = "uvp_absent_symbol";
const ABSENT_DECLARATION = `extern void ${ABSENT_SYMBOL}();`;
const ABSENT_CALL = `  ${ABSENT_SYMBOL}();`;

/**
 * Break the link: declare a symbol nothing defines, then call it from `main`.
 *
 * The declaration goes immediately above `int main() {` and the call immediately
 * inside it. Both are at the file's top level of scope, so a template that grows
 * more code around `main` still gets a valid translation unit that fails at the
 * link and not before it.
 */
const breakLink = (workspace: { readonly root: string }): void => {
  const path = join(workspace.root, "src", "main.cpp");
  const lines = readFileSync(path, "utf8").split("\n");
  const anchor = lines.findIndex((line) => MAIN_ANCHOR.test(line));
  if (anchor < 0) throw new Error(`no \`int main() {\` in ${path} to break`);
  lines.splice(anchor, 0, ABSENT_DECLARATION);
  // `main`'s opening brace moved down with the declaration, so the body's first
  // line is one further along than the call to `splice` above suggests.
  lines.splice(anchor + 2, 0, ABSENT_CALL);
  writeFileSync(path, lines.join("\n"));
};

/**
 * Whether this host's own linker answers in another language when asked to.
 *
 * The hostile-locale test below rests on a property of the *host* rather than of
 * uvp, so it is probed rather than assumed: on a machine with no `zh_CN` locale
 * installed an environment full of `zh_CN` changes nothing, and the test would
 * pass whether or not the build pinned a language for its subprocesses.
 *
 * `ld` directly rather than `g++`, because the linker's own message is the one
 * that goes missing when the format does not match. A driver would add a
 * translated line of its own (`collect2:`, `gmake: ***`) which says nothing about
 * whether the *linker's* line was readable. The option does not exist on any
 * linker, which is the point of the probe: the failure is instant, and the tool
 * says so in whatever language it was asked for.
 */
const probeHostLinkerLocale = (): { readonly localized: boolean; readonly said: string } => {
  const probe = spawnSync("ld", ["--uvp-locale-probe"], {
    env: { ...process.env, LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8" },
    encoding: "utf8",
    timeout: 10_000,
  });
  const said = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
  // The English wording the formats are written from; its absence is the
  // observation. So is no output at all, which is what a host without `ld` on
  // PATH produces and which is not a localization either.
  return { localized: said !== "" && !/unrecognized option/iu.test(said), said };
};

interface Diagnostic {
  readonly severity?: unknown;
  readonly file?: unknown;
  readonly line?: unknown;
  readonly column?: unknown;
  readonly message?: unknown;
  readonly phase?: unknown;
}

/** The diagnostics as the result carries them. */
const diagnosticsOf = (result: Record<string, unknown>): readonly Diagnostic[] => {
  const list = result["diagnostics"];
  if (!Array.isArray(list)) {
    throw new Error(`no diagnostics array in ${JSON.stringify(result).slice(0, 300)}`);
  }
  return list as readonly Diagnostic[];
};

/** The error contract on stderr, or a failure saying what was there instead. */
const failureOf = (
  outcome: { readonly stderr: string; readonly exit: number },
  where: string,
): ReturnType<typeof parseUvpError> => {
  try {
    return parseUvpError(JSON.parse(outcome.stderr));
  } catch {
    throw new Error(
      `${where} did not print one JSON object on stderr (exit ${String(outcome.exit)}): ` +
        outcome.stderr.slice(0, 300),
    );
  }
};

/**
 * Generate a template, build it successfully, then break it.
 *
 * Building it once first is what makes the failure attributable: the same
 * workspace built, and then did not, so the break is the only difference. It
 * also means a stale binary may be left in the build directory, which is why no
 * test below reads `artifacts` except the one written for exactly that.
 */
const generatedThenBroken = async (
  template: string,
  port: number,
  breakIt: (workspace: { readonly root: string }) => void,
) => {
  const workspace = await createWorkspace(template, port);
  const first = resultOrThrow(await buildWorkspace(workspace));
  expect(
    first["succeeded"],
    `the unbroken ${template} did not build: ${JSON.stringify(first["diagnostics"])}`,
  ).toBe(true);
  expect(existsSync(workspace.binary), `no binary at ${workspace.binary}`).toBe(true);
  breakIt(workspace);
  return workspace;
};

afterAll(() => {
  cleanup();
});

describe.skipIf(realLibuvcpp === undefined)(
  realLibuvcpp === undefined
    ? `a build that fails — skipped: ${skipReason}`
    : `a build that fails, on real CMake and libuvcpp ${realLibuvcpp.version}`,
  () => {
    it("reports a compile failure with the compiler's own diagnostic", async () => {
      const workspace = await generatedThenBroken("hello-http", 8095, breakSource);

      const outcome = await buildWorkspace(workspace);
      // A failed build is a **result**, not an error: the question "did it build?"
      // was asked and answered, and the answer belongs on stdout with its
      // evidence. Exit 1 is that answer — not exit 2, which would tell the caller
      // to fix the invocation.
      expect(outcome.exit).toBe(EXIT_NO);
      expect(outcome.stderr.trim()).toBe("");
      const result = resultOrThrow(outcome);
      expect(result["succeeded"]).toBe(false);
      expect(result["exit_code"]).not.toBe(0);
      // Time went into the compile, so the phase timing reports it. A build that
      // failed in two milliseconds would say the compiler never ran.
      expect(result["compile_duration_ms"]).toBeGreaterThan(0);

      const diagnostics = diagnosticsOf(result);
      const error = diagnostics.find((entry) => entry.severity === "error");
      expect(error, `no error diagnostic in ${JSON.stringify(diagnostics)}`).toBeDefined();
      expect(error?.phase).toBe("compile");
      // The file by path and the line by number: what a caller needs in order to
      // open the file at the failure.
      expect(String(error?.file)).toContain("main.cpp");
      expect(error?.line).toBe(lineOf(join(workspace.root, "src", "main.cpp"), BROKEN_LINE));
      // The compiler's own words. A substring, because the exact spelling is GCC's
      // — including the quotation marks it puts around `this`. Pinning the
      // typography would make this test fail on a compiler upgrade for a reason
      // that is not a regression.
      expect(String(error?.message)).toContain("in non-member function");
    });

    it("reports a configure failure by naming CMake's own error, not by promising one", async () => {
      const workspace = await generatedThenBroken("hello-http", 8096, breakConfigure);
      const expectedLine = lineOf(join(workspace.root, "CMakeLists.txt"), BROKEN_CMAKE_LINE);

      const outcome = await buildWorkspace(workspace);
      expect(outcome.exit).toBe(EXIT_NO);
      const result = resultOrThrow(outcome);
      expect(result["succeeded"]).toBe(false);
      expect(result["exit_code"]).not.toBe(0);
      // Configure never finished, so no compile was attempted. Zero here is the
      // honest report of work that did not happen.
      expect(result["compile_duration_ms"]).toBe(0);

      const diagnostics = diagnosticsOf(result);
      // **The regression.** This list used to be empty, under an envelope whose
      // limitation said "the diagnostics below are the compiler's own output,
      // reproduced as data" — a promise about text that was not there, in a field
      // that would never have held a compiler's output anyway. CMake's errors are
      // not compiler diagnostics, and the parser only knew the compiler formats.
      expect(diagnostics.length, "a configure failure reported no diagnostic").toBeGreaterThan(0);
      const error = diagnostics.find((entry) => entry.severity === "error");
      expect(error?.phase).toBe("configure");
      // The caller's own file, and the line in it — not one of CMake's modules.
      // Where the failure is reported inside a CMake module the header names the
      // module, which is CMake's own answer and is recorded as such (see the
      // recorded finding in `docs/testing.md`); this case is the plain one, and
      // the location is checked rather than assumed.
      expect(String(error?.file)).toContain("CMakeLists.txt");
      expect(error?.line).toBe(expectedLine);
      expect(String(error?.message)).toContain("Unknown CMake command");

      // The limitation now describes what was actually found. A result that says
      // "the diagnostics below" while holding an empty list is the failure mode
      // this test exists for, so the sentence is asserted rather than left to the
      // fix's good intentions.
      const limitations = result["limitations"] as readonly string[];
      expect(limitations.some((line) => line.includes("the tools' own messages"))).toBe(true);
      expect(
        limitations.some((line) => line.includes("no diagnostic")),
        `the limitation still claims diagnostics are missing: ${JSON.stringify(limitations)}`,
      ).toBe(false);
    });

    it("reports a link failure as a link failure, with the linker's own diagnostic", async () => {
      const workspace = await generatedThenBroken("hello-http", 8100, breakLink);
      const expectedLine = lineOf(join(workspace.root, "src", "main.cpp"), ABSENT_CALL);

      const outcome = await buildWorkspace(workspace);
      expect(outcome.exit).toBe(EXIT_NO);
      const result = resultOrThrow(outcome);
      expect(result["succeeded"]).toBe(false);
      expect(result["exit_code"]).not.toBe(0);
      // The compile ran and finished before the link failed, so time went into it.
      // Zero here would be the configure case — the compiler never ran at all.
      expect(result["compile_duration_ms"]).toBeGreaterThan(0);

      const diagnostics = diagnosticsOf(result);
      const error = diagnostics.find((entry) => entry.severity === "error");
      expect(error, `no error diagnostic in ${JSON.stringify(diagnostics)}`).toBeDefined();
      // **The regression.** The contract has had a `link` phase with no producer:
      // the linker's lines name a file, a line and a section and no column, so
      // every format the parser knew passed them by, and a link failure came back
      // as a build that failed with an empty diagnostic list — which reads as a
      // failure with no cause, and sends a caller back to re-run a compile that had
      // already succeeded.
      expect(error?.phase).toBe("link");
      // The caller's own file and the line in it, which is what a caller needs to
      // open the file where the missing symbol is used.
      expect(String(error?.file)).toContain("main.cpp");
      expect(error?.line).toBe(expectedLine);
      // The linker's own words. A substring, because the spelling of the demangled
      // symbol and the wording around it are the toolchain's, and pinning the whole
      // message would make this fail on a compiler upgrade for a reason that is not
      // a regression.
      expect(String(error?.message)).toContain(`undefined reference to \`${ABSENT_SYMBOL}()`);
    });

    it("asks the linker for English even when the caller's own locale is not English", async () => {
      const probe = probeHostLinkerLocale();
      // Never built successfully: this test is about the language of a failure's
      // diagnostics and not about attributing the failure to the edit, so the extra
      // successful build `generatedThenBroken` would do is work nothing asserts on.
      const workspace = await createWorkspace("hello-http", 8101);
      breakLink(workspace);

      // The environment someone with a Chinese locale actually has, passed to uvp
      // itself: the build inherits it, and this is the invocation that used to end
      // in a diagnostic list nothing could read.
      const outcome = await runCli(["build", workspace.root, "--json"], {
        env: { LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8", LC_MESSAGES: "zh_CN.UTF-8" },
      });
      expect(outcome.exit).toBe(EXIT_NO);
      const diagnostics = diagnosticsOf(resultOrThrow(outcome));
      const error = diagnostics.find((entry) => entry.severity === "error");
      expect(error, `no error diagnostic in ${JSON.stringify(diagnostics)}`).toBeDefined();
      expect(error?.phase).toBe("link");
      expect(String(error?.file)).toContain("main.cpp");
      expect(String(error?.message)).toContain(`undefined reference to \`${ABSENT_SYMBOL}()`);

      if (probe.localized) {
        // The same `ld`, on the same host, asked by the environment rather than by
        // uvp — the contrast is the evidence, and this is the text that would have
        // reached the parser had the build not set the language its output is read
        // in. `localized` already means the wording is not the English one, so what
        // is asserted here is the separate fact that a translated catalogue was
        // loaded at all: a message carrying a non-ASCII byte is one no pattern in
        // `src/toolchains/diagnostics.ts` matches.
        expect(
          /\P{ASCII}/u.test(probe.said),
          `the probe answered, but in ASCII: ${probe.said}`,
        ).toBe(true);
      } else {
        // Named rather than silent, and in the output: a host whose linker does not
        // localize cannot show the half that matters, so the run says so instead of
        // passing as though it had.
        console.log(
          "locale probe: this host's ld did not answer in another language " +
            `(${probe.said === "" ? "it printed nothing" : probe.said}), so the hostile ` +
            "environment was not shown to change anything — only the English half is asserted",
        );
      }
    });

    it("refuses to launch a workspace that failed to build", async () => {
      // The join between this lane and `process-boundary`: a build that failed
      // leaves nothing to run, and `uvp run` must say so. This workspace is
      // **never built successfully**, which is what makes the case clean — a
      // rebuild of an earlier success leaves the old binary in place, and that
      // binary is a thing the kernel will happily start (see the recorded finding
      // on the last test).
      const workspace = await createWorkspace("hello-http", 8097);
      breakSource(workspace);
      expect(
        resultOrThrow(await buildWorkspace(workspace))["succeeded"],
        "the broken workspace built, so this test would prove nothing",
      ).toBe(false);
      expect(existsSync(workspace.binary)).toBe(false);

      const launched = await runCli(["run", workspace.root, "--json"]);
      expect(launched.exit).toBe(EXIT_NO);
      // Nothing on stdout: a launch that did not happen has no result to report,
      // and a `ready: false` would be an answer to a question about a service
      // nobody started.
      expect(launched.stdout.trim()).toBe("");
      const error = failureOf(launched, "uvp run <failed build>");
      expect(error.code).toBe("launch_failed");
      expect(error.remediation.action).toContain("uvp build");
    });

    it("still reports a warning from a build that succeeded", async () => {
      // The control for "diagnostics are reported when they exist": a failing
      // build is not the only build with something to say. This is a generated
      // workspace plus one line CMake warns about, and the build must stay green
      // while carrying the warning — a tool that turned the warning into a failure
      // would be worse than one that dropped it.
      const workspace = await createWorkspace("hello-http", 8098);
      const path = join(workspace.root, "CMakeLists.txt");
      const before = readFileSync(path, "utf8");
      const after = before.replace(/project\(([^)]*)\)/u, "project($1 VERSION)");
      if (after === before) {
        throw new Error(`the project() line was not found to rewrite:\n${before}`);
      }
      writeFileSync(path, after);

      const outcome = await buildWorkspace(workspace);
      expect(outcome.exit, `the warning broke the build:\n${outcome.stdout.slice(0, 800)}`).toBe(
        EXIT_OK,
      );
      const result = resultOrThrow(outcome);
      expect(result["succeeded"]).toBe(true);
      const warning = diagnosticsOf(result).find((entry) => entry.severity === "warning");
      expect(warning, `no warning in ${JSON.stringify(diagnosticsOf(result))}`).toBeDefined();
      expect(warning?.phase).toBe("configure");
      expect(String(warning?.message)).toContain("VERSION");
      expect(existsSync(workspace.binary)).toBe(true);
    });

    it("leaves an earlier build's binary in place, which a failing rebuild does not disown", async () => {
      // **Recorded, not fixed — and the reason the launch test above uses a
      // never-built workspace.**
      //
      // `discoverArtifacts` walks the build directory whether or not the build
      // succeeded, and it is right to: those files exist, and their digests are
      // observations. What the *result* does with them is the open question. After
      // a failing rebuild the list still holds the binary the earlier, successful
      // build produced, described by a contract that calls these "the digests of
      // the produced artifacts" — so a caller reading `succeeded: false` next to a
      // non-empty `artifacts` can reasonably conclude the failure produced
      // something, and `uvp run` will start that older binary and serve it.
      //
      // Gating the list on `succeeded` is not obviously right either: a multi-target
      // build that fails on the last target has produced the earlier ones, and
      // hiding them would be its own lie. What is missing is a way to say which
      // artifacts predate the build, which is a change to a published output schema
      // — a product decision, not a defect in this lane's boundary. So the
      // behaviour is pinned here as the observed fact it is.
      const workspace = await generatedThenBroken("hello-http", 8099, breakSource);
      const result = resultOrThrow(await buildWorkspace(workspace));

      expect(result["succeeded"]).toBe(false);
      const artifacts = result["artifacts"] as readonly { readonly path?: unknown }[];
      // The binary from the previous build, reported by a build that failed.
      expect(artifacts.map((artifact) => String(artifact.path))).toEqual([workspace.binary]);
      // And it is really there, and really startable: the finding is not about a
      // stale path in a list.
      expect(existsSync(workspace.binary)).toBe(true);
    });
  },
);
