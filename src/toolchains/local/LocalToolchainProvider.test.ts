import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LocalToolchainProvider } from "./LocalToolchainProvider.js";

/**
 * What a build tells CMake about the library, and where that answer came from.
 *
 * The defect this file pins: uvp discovered a libuvcpp, reported it through
 * `uvp doctor`, and then built a workspace without pointing CMake at it. On a
 * release archive unpacked anywhere outside CMake's default search paths — which
 * is what uvp's own installation instructions tell a person to do — the
 * configure then failed with "required packages were not found: uvcpp", and the
 * whole `uvp verify` closure came back `unknown` for a library uvp had just
 * finished describing. `uvp build` passed the prefix and worked, so the two
 * answers to "which libuvcpp?" came from two places and disagreed.
 *
 * The fix moved the question into the toolchain, which is why the assertions
 * below are about a **relation** rather than a fixed expectation: the prefix the
 * configure command carries must be the prefix `findLibuvcpp` reports. Written
 * that way, the test says the same thing on a host with an install in
 * `/usr/local`, a host with one reachable only through `UVCPP_ROOT`, and a host
 * with none at all — and it cannot pass by naming a prefix uvp invented.
 *
 * **Nothing here compiles anything.** `cmake` on `PATH` is a symlink to `/bin/true`
 * for the duration of this file, so the build runs the real code path — the real
 * discovery, the real environment construction, the real `spawn` — and returns
 * its real result, without requiring a compiler on the machine that runs it. The
 * evidence asserted is the recorded command line, which is the same evidence a
 * caller receives when a build fails: what uvp actually ran, and under what
 * environment.
 */

/** A fake install prefix, laid out the way libuvcpp's archive is. */
const fakeInstall = (root: string, version: string): string => {
  const prefix = join(root, "libuvcpp");
  mkdirSync(join(prefix, "lib", "cmake", "uvcpp"), { recursive: true });
  mkdirSync(join(prefix, "lib", "pkgconfig"), { recursive: true });
  mkdirSync(join(prefix, "include", "uvcpp"), { recursive: true });
  writeFileSync(
    join(prefix, "include", "uvcpp", "uvcpp_config.h"),
    "#define UVCPP_HTTP_ENABLE 1\n#define UVCPP_WS_ENABLE 1\n",
  );
  writeFileSync(
    join(prefix, "lib", "cmake", "uvcpp", "uvcppConfig.cmake"),
    `set(PACKAGE_VERSION "${version}")\n`,
  );
  writeFileSync(
    join(prefix, "lib", "pkgconfig", "uvcpp.pc"),
    `prefix=${prefix}\nName: uvcpp\nVersion: ${version}\nLibs: -L\${prefix}/lib -luvcpp\n`,
  );
  return prefix;
};

let root: string;
let workspacePath: string;
let buildDir: string;
let installPrefix: string;
let otherPrefix: string;
let savedPath: string | undefined;
let savedRoot: string | undefined;

/** The signal a build under test is given. Real, and never aborted. */
const signal = new AbortController().signal;

beforeAll(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "uvp-provider-"));
  workspacePath = join(root, "ws");
  buildDir = join(workspacePath, "build");
  mkdirSync(workspacePath, { recursive: true });

  // `cmake` as `/bin/true`: it takes the arguments, exits 0, and says nothing.
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const cmake = join(bin, "cmake");
  // A symlink to `/bin/true`, which is executable already: no mode is set here,
  // because a process's `execvp` follows the link and finds the real file's
  // permissions, and setting them on a link is not a thing a filesystem does.
  symlinkSync("/bin/true", cmake);

  savedPath = process.env["PATH"];
  process.env["PATH"] = `${bin}:${savedPath ?? ""}`;
  savedRoot = process.env["UVCPP_ROOT"];

  installPrefix = fakeInstall(root, "1.7.0");
  otherPrefix = fakeInstall(join(root, "elsewhere"), "9.9.9");
  // `UVCPP_ROOT` leads the search order, so with it set the install this file
  // built is the one discovery answers with — on any host, whatever else is
  // installed. The assertions below check the relation, and this makes the
  // relation decidable rather than merely likely.
  process.env["UVCPP_ROOT"] = installPrefix;
});

afterAll(() => {
  if (savedPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = savedPath;
  if (savedRoot === undefined) delete process.env["UVCPP_ROOT"];
  else process.env["UVCPP_ROOT"] = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

const provider = new LocalToolchainProvider();

/** Build the workspace the way a workflow does: without naming a prefix. */
const buildWithoutPrefix = async () =>
  await provider.createClient().build({
    workspacePath,
    buildDir,
    buildType: "Debug",
    clean: false,
    timeoutMs: 60_000,
    configureOnly: false,
    signal,
  });

/** A `NAME=value` assignment as it appears in a recorded command, if present. */
const assignmentOf = (command: string, name: string): string | undefined =>
  new RegExp(String.raw`(?:^|\s)${name}=(\S+)`, "u").exec(command)?.[1];

describe("the libuvcpp a build points CMake at", () => {
  it("reads the fake install this file made, so the rest of the file means something", async () => {
    // The control. Without it, the assertions below could all hold on a host
    // where discovery found nothing and no environment was ever set.
    const found = await provider.findLibuvcpp(workspacePath, signal);
    expect(found.found).toBe(true);
    expect(found.installPrefix).toBe(installPrefix);
    expect(found.version).toBe("1.7.0");
    expect(found.modules).toEqual(["UVCPP_HTTP_ENABLE", "UVCPP_WS_ENABLE"]);
  });

  it("points CMake at the install it reports, on both routes libuvcpp ships by", async () => {
    const found = await provider.findLibuvcpp(workspacePath, signal);
    const outcome = await buildWithoutPrefix();
    const configure = outcome.commands[0] ?? "";

    // The relation the defect broke: what doctor describes and what the build
    // uses are the same install. A caller who reads the one and runs the other
    // gets the library they were told about.
    expect(assignmentOf(configure, "CMAKE_PREFIX_PATH")).toBe(found.installPrefix);
    // Both routes, because a prebuilt archive ships a `.pc` file and no CMake
    // package config at all: the first finds a `cmake --install`ed prefix, the
    // second finds the archive. Setting one leaves the other unfindable.
    expect(assignmentOf(configure, "PKG_CONFIG_PATH")).toBe(
      [join(installPrefix, "lib", "pkgconfig"), join(installPrefix, "lib64", "pkgconfig")].join(
        ":",
      ),
    );
  });

  it("keeps an existing CMAKE_PREFIX_PATH, since a caller put it there", async () => {
    // Appending rather than replacing: a caller who set a prefix path for a
    // dependency of their own must still get it, and a build that silently
    // dropped it would fail later, somewhere else, for a reason nobody could
    // trace back to the build.
    const existing = process.env["CMAKE_PREFIX_PATH"];
    process.env["CMAKE_PREFIX_PATH"] = "/somewhere/caller/put";
    try {
      const configure = (await buildWithoutPrefix()).commands[0] ?? "";
      const value = assignmentOf(configure, "CMAKE_PREFIX_PATH") ?? "";
      expect(value.startsWith(`${installPrefix}:`)).toBe(true);
      expect(value).toContain("/somewhere/caller/put");
    } finally {
      if (existing === undefined) delete process.env["CMAKE_PREFIX_PATH"];
      else process.env["CMAKE_PREFIX_PATH"] = existing;
    }
  });

  it("takes a caller's prefix at its word rather than discovering its own", async () => {
    // The `uvp build` path: it looked the install up and passes what it found.
    // Discovery must not overrule it — a caller naming a specific build is
    // naming it on purpose, and that install is the one its workspace's CMake
    // will be judged against.
    const outcome = await provider.createClient().build({
      workspacePath,
      buildDir,
      buildType: "Debug",
      clean: false,
      timeoutMs: 60_000,
      configureOnly: false,
      libuvcppPrefix: otherPrefix,
      signal,
    });
    const configure = outcome.commands[0] ?? "";
    expect(assignmentOf(configure, "CMAKE_PREFIX_PATH")).toBe(otherPrefix);
    expect(configure).not.toContain(installPrefix);
  });

  it("names no prefix it did not find, and carries the environment into the record", async () => {
    // The other direction, written against discovery's own answer so that it
    // holds on a host with no libuvcpp at all: when there is nothing to find,
    // nothing is invented — no empty assignment, no guessed `/usr/local`.
    const found = await provider.findLibuvcpp(workspacePath, signal);
    const outcome = await buildWithoutPrefix();
    const configure = outcome.commands[0] ?? "";

    if (found.found) {
      expect(assignmentOf(configure, "CMAKE_PREFIX_PATH")).toBe(found.installPrefix);
    } else {
      expect(configure.startsWith("env ")).toBe(false);
      expect(configure).not.toContain("CMAKE_PREFIX_PATH=");
    }

    // The recorded command is what a caller re-runs to read a failure, and the
    // environment is part of it: without `CMAKE_PREFIX_PATH` the re-run reports
    // a missing library for a build that failed on something else entirely.
    // `env NAME=value` is the POSIX spelling of the same environment.
    expect(configure.startsWith("env ")).toBe(found.found);
    expect(configure.slice(configure.indexOf("cmake"))).toContain("cmake -S ");
  });

  it("records the compile as a second command, without the configure environment", async () => {
    // `cmake --build` does not search for anything: the configure already wrote
    // the paths into the build tree. Carrying the environment there would be
    // noise in the record, and noise in a record is where a caller stops
    // reading it.
    const outcome = await buildWithoutPrefix();
    expect(outcome.commands).toHaveLength(2);
    expect(outcome.commands[1]).toBe(`cmake --build ${buildDir}`);
    expect(outcome.succeeded).toBe(true);
  });
});
