import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toUvpError, type UvpError } from "../../domain/errors.js";
import { installFakeTool } from "../../../tests/support/fakeExecutable.js";
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
 * **Nothing here compiles anything.** `cmake` on `PATH` is a program that takes
 * whatever arguments it is given, exits 0 and says nothing, for the duration of
 * this file, so the build runs the real code path — the real discovery, the real
 * environment construction, the real `spawn` — and returns its real result,
 * without requiring a compiler on the machine that runs it. The evidence asserted
 * is the recorded command line, which is the same evidence a caller receives when
 * a build fails: what uvp actually ran, and under what environment.
 *
 * That program is installed by `tests/support/fakeExecutable.ts` rather than
 * linked to `/bin/true` here, because what this host will start as `cmake` is not
 * the same file on every host — see that module for the two mechanisms.
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

/**
 * The one thing a Windows host does differently here, and where it is tracked.
 *
 * **The recorded line.** `processRunner.ts` renders an environment assignment as
 * `NAME='C:\path'`, which is the correct POSIX spelling and not something a
 * Windows shell re-runs; `assignmentOf` below then reads the quotes as part of
 * the value. Four assertions compare the raw line, so they fail on the quoting
 * rather than on the prefix. Whether the record should be rendered in the host's
 * dialect, or say which dialect it is, is the open question in #20 — the fix is
 * not to teach this file a second regex, which is the defect showing through.
 */
const recordGap =
  process.platform === "win32"
    ? "a recorded command line is rendered in POSIX dialect and read here as a raw string (see #20)"
    : undefined;

/** `title`, with the reason attached on the host that cannot run it. */
const named = (title: string, reason: string | undefined): string =>
  reason === undefined ? title : `${title} — skipped: ${reason}`;

let root: string;
let workspacePath: string;
let buildDir: string;
let installPrefix: string;
let otherPrefix: string;
let savedPath: string | undefined;
let savedRoot: string | undefined;
let savedNodeOptions: string | undefined;

/** The signal a build under test is given. Real, and never aborted. */
const signal = new AbortController().signal;

/**
 * The `cmake` this file puts on `PATH`, as the program it runs.
 *
 * A program, not a banner in a script: the provider chooses this command's
 * arguments itself, so the program is baked into the fake rather than passed to
 * it, and the two hosts bake it in differently. See
 * `tests/support/fakeExecutable.ts`.
 */
const SUCCEEDS_QUIETLY = fileURLToPath(
  new URL("../../../tests/support/fixtures/succeedsQuietly.mjs", import.meta.url),
);

beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "uvp-provider-"));
  workspacePath = join(root, "ws");
  buildDir = join(workspacePath, "build");
  mkdirSync(workspacePath, { recursive: true });

  // A `cmake` that takes its arguments, exits 0, and says nothing.
  const bin = join(root, "bin");
  const cmake = await installFakeTool(bin, "cmake", { module: SUCCEEDS_QUIETLY });

  savedPath = process.env["PATH"];
  savedNodeOptions = process.env["NODE_OPTIONS"];
  // On a host where the fake is a copy of Node rather than a script, the program
  // reaches it through the environment: the provider chooses the command line, so
  // there is nowhere else for a test to put it. Set before the first provider
  // call, because the child inherits this process's environment at spawn time.
  if (cmake.env["NODE_OPTIONS"] !== undefined) {
    process.env["NODE_OPTIONS"] = cmake.env["NODE_OPTIONS"];
  }
  // Joined with the separator this host uses rather than with `:` — a `PATH` is
  // one of the few things no two platforms spell the same way, and a literal here
  // would put a Windows directory and the rest of the path into one entry.
  process.env["PATH"] = [bin, savedPath ?? ""].join(delimiter);
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
  if (savedNodeOptions === undefined) delete process.env["NODE_OPTIONS"];
  else process.env["NODE_OPTIONS"] = savedNodeOptions;
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

  it.skipIf(recordGap !== undefined)(
    named("points CMake at the install it reports, on both routes libuvcpp ships by", recordGap),
    async () => {
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
    },
  );

  it.skipIf(recordGap !== undefined)(
    named("keeps an existing CMAKE_PREFIX_PATH, since a caller put it there", recordGap),
    async () => {
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
    },
  );

  it.skipIf(recordGap !== undefined)(
    named("takes a caller's prefix at its word rather than discovering its own", recordGap),
    async () => {
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
    },
  );

  it.skipIf(recordGap !== undefined)(
    named("names no prefix it did not find, and carries the locale into the record", recordGap),
    async () => {
      // The other direction, written against discovery's own answer so that it
      // holds on a host with no libuvcpp at all: when there is nothing to find,
      // nothing is invented — no empty assignment, no guessed `/usr/local`.
      const found = await provider.findLibuvcpp(workspacePath, signal);
      const outcome = await buildWithoutPrefix();
      const configure = outcome.commands[0] ?? "";

      if (found.found) {
        expect(assignmentOf(configure, "CMAKE_PREFIX_PATH")).toBe(found.installPrefix);
      } else {
        expect(assignmentOf(configure, "CMAKE_PREFIX_PATH")).toBeUndefined();
      }

      // The recorded command is what a caller re-runs to read a failure, and the
      // environment is part of it: without `CMAKE_PREFIX_PATH` the re-run reports a
      // missing library for a build that failed on something else entirely. The
      // locale pin is there unconditionally, because it is not a fact about the
      // install — it is the language the output is *read* in, so a record without it
      // re-runs into a linker that answers in the host's language while every
      // diagnostic uvp reports is English. `env NAME=value` is the POSIX spelling of
      // both, and the two halves are asserted apart for that reason.
      expect(configure.startsWith("env ")).toBe(true);
      expect(assignmentOf(configure, "LC_MESSAGES")).toBe("C");
      expect(configure.slice(configure.indexOf("cmake"))).toContain("cmake -S ");
    },
  );

  it("records the compile as a second command, with the locale pin and no prefix", async () => {
    // `cmake --build` does not search for anything: the configure already wrote the
    // paths into the build tree, so a prefix here would be noise in the record, and
    // noise in a record is where a caller stops reading it. The locale pin is the
    // other half and is not conditional — this is the step the compiler and the
    // linker print in, and the step whose output is parsed, so it is the one where
    // re-running the recorded line without it would answer in another language.
    const outcome = await buildWithoutPrefix();
    expect(outcome.commands).toHaveLength(2);
    const compile = outcome.commands[1] ?? "";
    expect(assignmentOf(compile, "CMAKE_PREFIX_PATH")).toBeUndefined();
    expect(assignmentOf(compile, "LC_MESSAGES")).toBe("C");
    expect(compile.endsWith(`cmake --build ${buildDir}`)).toBe(true);
    expect(outcome.succeeded).toBe(true);
  });
});

/**
 * A call the caller withdrew from.
 *
 * The defect this pins: cancellation was laundered into a finding. An interrupted
 * inspection returned the compiler list it had collected so far, and an empty
 * list is precisely what makes `available` false — so `uvp doctor`, stopped with
 * Ctrl-C, told a person to install a C++ compiler. An interrupted search returned
 * `found: false` with a note the reader of `found` has no reason to open, and an
 * interrupted configure came back as a build that failed. Each is a claim about
 * the machine drawn from a run that observed nothing, and each sends the caller
 * off to fix something that may not be broken.
 *
 * The contract already has a code for this, so what is checked here is that every
 * layer spells it rather than answering: the caller gets `cancelled`, and the
 * message says the run was interrupted instead of saying what the host has.
 */

/** A signal that was already aborted when the call was made. */
const withdrawn = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

/** Make a call, and hand back the failure in the shape a caller receives it. */
const failureOf = async (call: () => Promise<unknown>): Promise<UvpError> => {
  try {
    await call();
  } catch (cause) {
    return toUvpError(cause);
  }
  throw new Error("This call was expected to report a cancellation, and answered instead.");
};

describe("a call whose signal was already aborted", () => {
  it("names a cancelled inspection, rather than a host with no compiler", async () => {
    // Whether a person goes and installs a compiler turns on this one answer.
    const failure = await failureOf(() => provider.inspectAvailability(withdrawn()));

    expect(failure.code).toBe("cancelled");
    expect(failure.category).toBe("cancelled");
    // Not retryable: nothing about the host was learned, and the caller is the one
    // who decided to stop. Re-running is their call to make, not a loop's.
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("cancelled");
  });

  it("names a cancelled search, rather than a machine with no libuvcpp", async () => {
    // `UVCPP_ROOT` points at the install this file built, so a search that had
    // run would have found one. Nothing about this answer can be read as "there
    // is none here".
    const failure = await failureOf(() => provider.findLibuvcpp(workspacePath, withdrawn()));
    expect(failure.code).toBe("cancelled");
    expect(failure.message).toContain("cancelled");
  });

  it("names a cancelled build, rather than a workspace that does not compile", async () => {
    // The control: this workspace has no `CMakeLists.txt`, and `cmake` here is a
    // program that always exits 0, so the same build with a live signal reports
    // success. A `succeeded: false` reached by aborting would therefore be a claim
    // about code that nothing compiled, and the control is what rules out a second
    // reason for it to fail.
    expect((await buildWithoutPrefix()).succeeded).toBe(true);

    const failure = await failureOf(() =>
      provider.createClient().build({
        workspacePath,
        buildDir,
        buildType: "Debug",
        clean: false,
        timeoutMs: 60_000,
        configureOnly: false,
        // A prefix is named so the build reaches the process it would have run:
        // without one it stops in the search instead, which is the test above.
        libuvcppPrefix: otherPrefix,
        signal: withdrawn(),
      }),
    );

    expect(failure.code).toBe("cancelled");
    expect(failure.message).toContain("cancelled");
  });
});
