import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toUvpError, type UvpError } from "../../domain/errors.js";
import { isWindows } from "../host.js";
import { renderCommand } from "../processRunner.js";
import type { ProcessOutcome, RunProcessOptions } from "../processRunner.js";
import { installFakeTool } from "../../../tests/support/fakeExecutable.js";
import { assignmentOf, wordsOf } from "../../../tests/support/recordedCommand.js";
import { removeTree } from "../../../tests/support/temporaryTree.js";
import {
  LocalToolchainProvider,
  discoverLibuvcpp,
  pkgConfigCandidateNames,
  pkgConfigHelpAccepted,
  pkgConfigValidatesCandidate,
  probeInvocation,
} from "./LocalToolchainProvider.js";

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
 * The runner the build tests use on a host whose `cmake` stand-in cannot be
 * started.
 *
 * The provider chooses this command's arguments — `-S <ws> -B <build>` to
 * configure, `--build <build>` to compile. On Windows the `cmake` on `PATH` is a
 * copy of the Node running this suite (`tests/support/fakeExecutable.ts`), and
 * Node reads its own command line before any of the suite's code can run, so it
 * answers the provider's arguments itself:
 *
 *     node -S /tmp/ws -B /tmp/ws/build -DCMAKE_BUILD_TYPE=Debug
 *     node: bad option: -S                        → exit 9
 *     node --build /tmp/ws/build
 *     node: bad option: --build                   → exit 9
 *
 * Nothing is imported in that run, which is why the program the fake carries
 * never executes and the configure the assertions read never happened. #22
 * recorded that wall and left the product change to a maintainer; #11 is the
 * Windows C++ lane that needs it, so the provider now takes a `run` slot
 * (`LocalProviderOptions`) and this file uses it on Windows.
 *
 * What the injected runner does **not** establish is that the host can start
 * `cmake`. It answers the request the provider would have made, rendering the
 * command line through the same `renderCommand` that `runProcess` uses, so the
 * assertions below still read the product's decision rather than a second
 * spelling of it. On every other host the real runner is used and the real child
 * is started; the Windows toolchain lane is where a real `cmake` runs on that
 * platform.
 */
const syntheticRun = async (options: RunProcessOptions): Promise<ProcessOutcome> => {
  const aborted = options.signal?.aborted === true;
  return {
    command: renderCommand(options),
    exitCode: aborted ? null : 0,
    signal: null,
    timedOut: false,
    aborted,
    durationMs: 0,
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
};

let root: string;
let workspacePath: string;
let buildDir: string;
let installPrefix: string;
let otherPrefix: string;
let savedPath: string | undefined;
let savedRoot: string | undefined;
let savedNodeOptions: string | undefined;
let savedCmakePrefixPath: string | undefined;
let savedPkgConfigPath: string | undefined;

/** The signal a build under test is given. Real, and never aborted. */
const signal = new AbortController().signal;

/**
 * The `cmake` this file puts on `PATH`, as the program it runs.
 *
 * A program, not a banner in a script: the provider chooses this command's
 * arguments itself, so the program is baked into the fake rather than passed to
 * it, and the two hosts bake it in differently. See
 * `tests/support/fakeExecutable.ts` for the two mechanisms. The build tests start
 * this fake on POSIX; on Windows they use the injected `syntheticRun`, because a
 * copy of Node cannot be handed `-S`/`--build`.
 */
const SUCCEEDS_QUIETLY = fileURLToPath(
  new URL("../../../tests/support/fixtures/succeedsQuietly.mjs", import.meta.url),
);

beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "uvp-provider-"));
  workspacePath = join(root, "ws");
  buildDir = join(workspacePath, "build");
  mkdirSync(workspacePath, { recursive: true });

  // A `cmake` whose arguments mean nothing to it: exits 0 and says nothing. On
  // Windows it is a copy of Node answering its own `bad option` for the build
  // commands; the build tests below therefore use `buildProvider`, whose injected
  // runner answers the provider's request without starting that copy.
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

  // Both prefixes are paths `shellQuote` has to quote, on any host: one has a
  // space, the other an apostrophe, which is the escape inside a quoted value.
  // Without them the record happens to need no quoting on a POSIX host and the
  // assertions below would stop covering the notation they read — the Windows
  // lane was the only place the quote was ever exercised, which is exactly how
  // the reader came to be wrong there and nowhere else.
  installPrefix = fakeInstall(join(root, "an install"), "1.7.0");
  otherPrefix = fakeInstall(join(root, "an other's install"), "9.9.9");
  // `UVCPP_ROOT` leads the search order, so with it set the install this file
  // built is the one discovery answers with — on any host, whatever else is
  // installed. The assertions below check the relation, and this makes the
  // relation decidable rather than merely likely.
  process.env["UVCPP_ROOT"] = installPrefix;

  // The build inherits this process's environment, and the provider appends
  // its own entries to a caller's search paths rather than replacing them — so
  // an exported `PKG_CONFIG_PATH` or `CMAKE_PREFIX_PATH` reaches every recorded
  // command line below. A developer who exported one is following the
  // installation instructions: pointing at an unpacked release archive, or at
  // a `cmake --install` prefix. Clearing both for the duration keeps the exact
  // assertions about what the provider adds from depending on what their shell
  // already had (#210). The two preserve tests set each variable themselves and
  // restore it, so the append rule stays covered on purpose.
  savedCmakePrefixPath = process.env["CMAKE_PREFIX_PATH"];
  savedPkgConfigPath = process.env["PKG_CONFIG_PATH"];
  delete process.env["CMAKE_PREFIX_PATH"];
  delete process.env["PKG_CONFIG_PATH"];
});

afterAll(async () => {
  if (savedPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = savedPath;
  if (savedRoot === undefined) delete process.env["UVCPP_ROOT"];
  else process.env["UVCPP_ROOT"] = savedRoot;
  if (savedNodeOptions === undefined) delete process.env["NODE_OPTIONS"];
  else process.env["NODE_OPTIONS"] = savedNodeOptions;
  if (savedCmakePrefixPath === undefined) delete process.env["CMAKE_PREFIX_PATH"];
  else process.env["CMAKE_PREFIX_PATH"] = savedCmakePrefixPath;
  if (savedPkgConfigPath === undefined) delete process.env["PKG_CONFIG_PATH"];
  else process.env["PKG_CONFIG_PATH"] = savedPkgConfigPath;
  await removeTree(root);
});

const provider = new LocalToolchainProvider();

/**
 * The provider the build assertions use.
 *
 * On Windows it is the same provider with a runner that answers instead of
 * starting a Node copy; on every other host it is `provider`, so the real
 * `spawn` stays part of the evidence.
 */
const buildProvider: LocalToolchainProvider = isWindows
  ? new LocalToolchainProvider({ run: syntheticRun })
  : provider;

/** Build the workspace the way a workflow does: without naming a prefix. */
const buildWithoutPrefix = async () =>
  await buildProvider.createClient().build({
    workspacePath,
    buildDir,
    buildType: "Debug",
    clean: false,
    timeoutMs: 60_000,
    configureOnly: false,
    signal,
  });

describe("the libuvcpp a build points CMake at", () => {
  it("reads the fake install this file made, so the rest of the file means something", async () => {
    // The control. Without it, the assertions below could all hold on a host
    // where discovery found nothing and no environment was ever set.
    const found = await provider.findLibuvcpp(workspacePath, signal);
    expect(found.found).toBe(true);
    expect(found.installPrefix).toBe(installPrefix);
    expect(found.version).toBe("1.7.0");
    expect(found.modules).toEqual(["UVCPP_HTTP_ENABLE", "UVCPP_WS_ENABLE"]);
    // This prefix carries `lib/cmake/uvcpp/uvcppConfig.cmake`, so the generated
    // project's first route answers and pkg-config is not a prerequisite.
    expect(found.cmakePackage).toBe(true);
  });

  /** Discovery of `prefix`, with `UVCPP_ROOT` pointed at it for one call. */
  const findUnderRoot = async (prefix: string) => {
    const saved = process.env["UVCPP_ROOT"];
    process.env["UVCPP_ROOT"] = prefix;
    try {
      return await provider.findLibuvcpp(workspacePath, signal);
    } finally {
      if (saved === undefined) delete process.env["UVCPP_ROOT"];
      else process.env["UVCPP_ROOT"] = saved;
    }
  };

  it("reports an archive with no CMake package, which is the pkg-config route", async () => {
    // A release archive's shape: the config header and `uvcpp.pc`, and no
    // `cmake/uvcpp` directory at all. The doctor decides the route from this
    // observation, so it has to be an observation and not a guess from the
    // version source.
    const prefix = join(root, "archive-only");
    mkdirSync(join(prefix, "lib", "pkgconfig"), { recursive: true });
    mkdirSync(join(prefix, "include", "uvcpp"), { recursive: true });
    writeFileSync(
      join(prefix, "include", "uvcpp", "uvcpp_config.h"),
      "#define UVCPP_HTTP_ENABLE 1\n",
    );
    writeFileSync(join(prefix, "lib", "pkgconfig", "uvcpp.pc"), "Name: uvcpp\nVersion: 1.7.0\n");

    const found = await findUnderRoot(prefix);
    expect(found.found).toBe(true);
    expect(found.versionSource).toBe("pkgconfig");
    expect(found.cmakePackage).toBe(false);
  });

  it("marks a module list it could not read as unknown, not as an empty one", async () => {
    // A prefix can carry the CMake package file without the config header the
    // module list is read from — a partial or permission-restricted install.
    // Reporting `modules: []` alone would let a consumer conclude "this build
    // enables nothing", which is a finding nobody made.
    const prefix = join(root, "headerless");
    mkdirSync(join(prefix, "lib", "cmake", "uvcpp"), { recursive: true });
    writeFileSync(
      join(prefix, "lib", "cmake", "uvcpp", "uvcppConfig.cmake"),
      'set(PACKAGE_VERSION "1.7.0")\n',
    );

    const found = await findUnderRoot(prefix);
    expect(found.found).toBe(true);
    expect(found.installPrefix).toBe(prefix);
    expect(found.modules).toEqual([]);
    expect(found.modulesUnknown).toBe(true);
    expect(found.note).toContain("module list is unknown");
  });

  it("reports an empty module list as an observation when the header was read", async () => {
    // The other half of the distinction: a header that was read and defines no
    // modules is a real answer, and it must not be labelled unknown.
    const prefix = join(root, "empty-header");
    mkdirSync(join(prefix, "lib", "cmake", "uvcpp"), { recursive: true });
    mkdirSync(join(prefix, "include", "uvcpp"), { recursive: true });
    writeFileSync(
      join(prefix, "lib", "cmake", "uvcpp", "uvcppConfig.cmake"),
      'set(PACKAGE_VERSION "1.7.0")\n',
    );
    writeFileSync(join(prefix, "include", "uvcpp", "uvcpp_config.h"), "\n");

    const found = await findUnderRoot(prefix);
    expect(found.found).toBe(true);
    expect(found.modules).toEqual([]);
    expect(found.modulesUnknown).toBeUndefined();
    expect(found.note).toBeUndefined();
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
    // Exact, because this file clears the caller's search paths in `beforeAll`;
    // the append rule they would otherwise contribute is asserted below.
    expect(assignmentOf(configure, "PKG_CONFIG_PATH")).toBe(
      [join(installPrefix, "lib", "pkgconfig"), join(installPrefix, "lib64", "pkgconfig")].join(
        delimiter,
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
      expect(value.startsWith(`${installPrefix}${delimiter}`)).toBe(true);
      expect(value).toContain("/somewhere/caller/put");
    } finally {
      if (existing === undefined) delete process.env["CMAKE_PREFIX_PATH"];
      else process.env["CMAKE_PREFIX_PATH"] = existing;
    }
  });

  it("keeps an existing PKG_CONFIG_PATH, since a caller put it there", async () => {
    // The same rule on the other route: the prebuilt-archive search path is
    // extended, not replaced. Without this test the preserve behaviour would
    // only ever be exercised by whatever the developer's shell happened to
    // contain — which is how #210 went unnoticed until a run with it exported.
    const existing = process.env["PKG_CONFIG_PATH"];
    process.env["PKG_CONFIG_PATH"] = "/somewhere/caller/put";
    try {
      const configure = (await buildWithoutPrefix()).commands[0] ?? "";
      const value = assignmentOf(configure, "PKG_CONFIG_PATH") ?? "";
      expect(
        value.startsWith(
          `${[join(installPrefix, "lib", "pkgconfig"), join(installPrefix, "lib64", "pkgconfig")].join(delimiter)}${delimiter}`,
        ),
      ).toBe(true);
      expect(value).toContain("/somewhere/caller/put");
    } finally {
      if (existing === undefined) delete process.env["PKG_CONFIG_PATH"];
      else process.env["PKG_CONFIG_PATH"] = existing;
    }
  });

  it("takes a caller's prefix at its word rather than discovering its own", async () => {
    // The `uvp build` path: it looked the install up and passes what it found.
    // Discovery must not overrule it — a caller naming a specific build is
    // naming it on purpose, and that install is the one its workspace's CMake
    // will be judged against.
    const outcome = await buildProvider.createClient().build({
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

  it("names no prefix it did not find, and carries the locale into the record", async () => {
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
  });

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
    // Read the record in its own notation rather than as raw text. On Windows
    // the build directory is single-quoted because it contains backslashes, so an
    // `endsWith` comparison fails on the quoting rather than on the command. The
    // configuration selector is the other half: multi-configuration generators
    // ignore `CMAKE_BUILD_TYPE` and read `--config`, so the recorded compile line
    // must carry the caller's build type.
    const words = wordsOf(compile);
    expect(words).toContain(buildDir);
    expect(words.slice(-2)).toEqual(["--config", "Debug"]);
    expect(outcome.succeeded).toBe(true);
  });
});

describe("the answer when a prefix has only half of an install", () => {
  /**
   * A fresh root, removed by the test that made it. The discovery function is
   * handed the roots explicitly rather than reading the environment, because
   * the found-nothing branch is only reached when no root has an install — and
   * whether this host has one under `/usr` is not something the test may depend
   * on (#210 was the same lesson in a different place).
   */
  const freshRoot = (): string => mkdtempSync(join(realpathSync(tmpdir()), "uvp-half-"));

  it("names a shared library it found, and the package that carries the rest", async () => {
    // The shape `libuvcpp1-1.7.4-1.x86_64.rpm` installs: the versioned library
    // and its `.so.1` link, and nothing else. "No installation found" is
    // misleading advice to someone in exactly that state, and #213 is that
    // report: the runtime package was installed and the development one was not.
    const root = freshRoot();
    try {
      mkdirSync(join(root, "lib64"), { recursive: true });
      writeFileSync(join(root, "lib64", "libuvcpp.so.1"), "");
      writeFileSync(join(root, "lib64", "libuvcpp.so.1.7.4"), "");

      const found = await discoverLibuvcpp([root], signal);
      expect(found.found).toBe(false);
      expect(found.note).toContain(join(root, "lib64", "libuvcpp.so.1"));
      expect(found.note).toContain("libuvcpp-devel");
      expect(found.note).toContain("libuvcpp-dev");
    } finally {
      await removeTree(root);
    }
  });

  it("keeps the generic note when the prefixes hold nothing at all", async () => {
    const root = freshRoot();
    try {
      const found = await discoverLibuvcpp([root], signal);
      expect(found.found).toBe(false);
      expect(found.note).toContain("No libuvcpp installation found");
      expect(found.note).not.toContain("shared library");
    } finally {
      await removeTree(root);
    }
  });

  it("accepts a CMake package under lib64 as a route", async () => {
    // VERSION_SOURCES already reads lib64; discovery did not. A distribution
    // that installs into lib64 puts the package file there, and the prefix was
    // reported as missing whenever no config header was readable.
    const root = freshRoot();
    try {
      mkdirSync(join(root, "lib64", "cmake", "uvcpp"), { recursive: true });
      writeFileSync(join(root, "lib64", "cmake", "uvcpp", "uvcppConfig.cmake"), "");

      const found = await discoverLibuvcpp([root], signal);
      expect(found.found).toBe(true);
      expect(found.installPrefix).toBe(root);
      // No header, so the module list is unknown rather than empty — the same
      // distinction the lib/ route makes.
      expect(found.modules).toEqual([]);
      expect(found.modulesUnknown).toBe(true);
    } finally {
      await removeTree(root);
    }
  });

  it("does not call a prefix incomplete when its config header was read", async () => {
    // A header that defines nothing is a readable answer, not a missing file.
    // The note must not send that caller to install a development package they
    // already have.
    const root = freshRoot();
    try {
      mkdirSync(join(root, "include", "uvcpp"), { recursive: true });
      mkdirSync(join(root, "lib64"), { recursive: true });
      writeFileSync(join(root, "include", "uvcpp", "uvcpp_config.h"), "\n");
      writeFileSync(join(root, "lib64", "libuvcpp.so.1"), "");

      const found = await discoverLibuvcpp([root], signal);
      expect(found.found).toBe(false);
      expect(found.note).not.toContain("shared library");
      expect(found.note).toContain("No libuvcpp installation found");
    } finally {
      await removeTree(root);
    }
  });
});

describe("the process runner a local build is given", () => {
  it("uses that runner for both steps, rather than starting cmake itself", async () => {
    // The seam's own claim, on every host. The assertions on the requests are the
    // provider's decisions — the arguments it chooses and the environment it
    // builds — not a second copy of the command line.
    const seen: RunProcessOptions[] = [];
    const scripted = new LocalToolchainProvider({
      run: async (options) => {
        seen.push(options);
        return await syntheticRun(options);
      },
    });

    const outcome = await scripted.createClient().build({
      workspacePath,
      buildDir,
      buildType: "Release",
      clean: false,
      timeoutMs: 60_000,
      configureOnly: false,
      signal,
    });

    expect(seen.map((call) => call.command)).toEqual(["cmake", "cmake"]);
    expect(seen[0]?.args.slice(0, 4)).toEqual(["-S", workspacePath, "-B", buildDir]);
    // The compile step names the configuration for multi-configuration
    // generators; this is the assertion that would have caught a Release request
    // silently building Debug on the default Windows/macOS generator.
    expect(seen[1]?.args.slice(0, 4)).toEqual(["--build", buildDir, "--config", "Release"]);
    expect(outcome.commands).toHaveLength(2);
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
      buildProvider.createClient().build({
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

/** Run `body` with `PATH` replaced, restoring it even when the body throws. */
const withPath = async <T>(path: string, body: () => Promise<T>): Promise<T> => {
  const saved = process.env["PATH"];
  process.env["PATH"] = path;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env["PATH"];
    else process.env["PATH"] = saved;
  }
};

/**
 * The pkg-config executable, as an observation rather than a requirement.
 *
 * Whether a workspace needs pkg-config depends on the libuvcpp route, which is
 * a fact the doctor has only after discovery. The provider's job is to say
 * whether it looked and what it saw: an absent field means "not looked", `{}`
 * means "looked, found nothing", and a path means "found it". Collapsing the
 * first into the second is how a check that never ran becomes an instruction to
 * install something.
 */
describe("the pkg-config executable", () => {
  it("reports the executable it found, and does not call it missing", async () => {
    const bin = join(root, "pkg-config-bin");
    await installFakeTool(bin, "pkg-config", { module: SUCCEEDS_QUIETLY });

    const availability = await withPath(bin, () => provider.inspectAvailability(signal));

    expect(availability.pkgConfig?.path?.startsWith(bin)).toBe(true);
    // Discovery decides the requirement, not the inspection: this host may have
    // a CMake-package libuvcpp, in which case pkg-config is never invoked.
    expect(availability.missing.map((gap) => gap.id)).not.toContain("pkg-config");
  });

  it("reports that it looked and found nothing, rather than saying nothing", async () => {
    const empty = join(root, "empty-bin");
    mkdirSync(empty, { recursive: true });

    const availability = await withPath(empty, () => provider.inspectAvailability(signal));

    expect(availability.pkgConfig).toEqual({});
    expect(availability.missing.map((gap) => gap.id)).not.toContain("pkg-config");
  });

  it("accepts pkgconf, the other name for the same program", async () => {
    const bin = join(root, "pkgconf-bin");
    await installFakeTool(bin, "pkgconf", { module: SUCCEEDS_QUIETLY });

    const availability = await withPath(bin, () => provider.inspectAvailability(signal));

    expect(availability.pkgConfig?.path?.includes("pkgconf")).toBe(true);
  });
});

/**
 * Which names CMake's `FindPkgConfig` would search, and which candidate it would
 * accept.
 *
 * The provider has to ask the question CMake will ask, because the doctor's
 * verdict and the build's outcome are about the same configure. The details
 * differ by CMake version and by host, and getting either wrong has a direction:
 * a host with a working executable reported as missing sends someone to install
 * a second copy of it. The probe itself cannot be exercised against the
 * versioning rules — the host running the test has one CMake and one platform —
 * so the two decisions are exported and tested directly, and the tests above run
 * the probe around them.
 */
describe("what CMake's FindPkgConfig searches", () => {
  it("searches pkg-config alone before CMake 3.22", () => {
    // 3.22 is the release that added `pkgconf` to the module's name list; on
    // 3.20 and 3.21 a host with only pkgconf fails to configure, so counting it
    // as found would be the same false "it is there" in reverse. The host is
    // named explicitly so this asserts the Unix list on every lane; the Windows
    // list has its own test below.
    expect(pkgConfigCandidateNames("3.20.0", false)).toEqual(["pkg-config"]);
    expect(pkgConfigCandidateNames("3.21.3", false)).toEqual(["pkg-config"]);
    expect(pkgConfigCandidateNames("3.22.0", false)).toEqual(["pkg-config", "pkgconf"]);
  });

  it("searches pkgconf on every later 3.x, and on 4.x", () => {
    expect(pkgConfigCandidateNames("3.28.3", false)).toEqual(["pkg-config", "pkgconf"]);
    expect(pkgConfigCandidateNames("3.31.0", false)).toEqual(["pkg-config", "pkgconf"]);
    expect(pkgConfigCandidateNames("4.0.0", false)).toEqual(["pkg-config", "pkgconf"]);
  });

  it("searches the newer list when the CMake version could not be read", () => {
    // The version is read from `cmake --version`, which can fail; `undefined`
    // is "could not look". The conservative answer is the newer search, because
    // missing a `pkgconf` CMake would have used is the false absence this probe
    // exists to avoid.
    expect(pkgConfigCandidateNames(undefined, false)).toEqual(["pkg-config", "pkgconf"]);
  });

  it("searches pkg-config.bat first on Windows, as the module does", () => {
    // v3.20's module prepends the `.bat` name on Windows rather than appending
    // it, and that order decides which path a host with both gets reported.
    expect(pkgConfigCandidateNames("3.20.0", true)).toEqual(["pkg-config.bat", "pkg-config.exe"]);
    expect(pkgConfigCandidateNames("3.31.0", true)).toEqual([
      "pkg-config.bat",
      "pkg-config.exe",
      "pkgconf.exe",
    ]);
  });

  it("runs the validator from 3.29.1, the release that added it", () => {
    // 3.29.0 has no validator; 3.29.1 through 3.29.6 and 3.30+ do. The patch
    // component decides: a whole-minor gate would skip 3.29.1–3.29.6, and there
    // the probe would search the right names while never applying the check
    // that decides, reporting a host ready whose configure then fails.
    expect(pkgConfigValidatesCandidate("3.28.3", true)).toBe(false);
    expect(pkgConfigValidatesCandidate("3.29.0", true)).toBe(false);
    expect(pkgConfigValidatesCandidate("3.29.1", true)).toBe(true);
    expect(pkgConfigValidatesCandidate("3.29.6", true)).toBe(true);
    expect(pkgConfigValidatesCandidate("3.30.0", true)).toBe(true);
    expect(pkgConfigValidatesCandidate("4.0.0", true)).toBe(true);
    // The validator is a Windows-only step of `find_program`; elsewhere the
    // version alone does not make it apply.
    expect(pkgConfigValidatesCandidate("3.29.6", false)).toBe(false);
    // An unreadable version takes the broader branch, as the name list does.
    expect(pkgConfigValidatesCandidate(undefined, true)).toBe(true);
  });

  it("accepts a non-.exe candidate only when CMake's 3.29.1 validator would", () => {
    // From 3.29.1, Windows runs `--help` on a candidate without `.exe` and rejects
    // it unless that exits 0. Strawberry Perl's shim is the real case: it is
    // found, answers `--version`, and is rejected by CMake — so the probe must
    // reject it too rather than promise a configure that then fails.
    expect(pkgConfigHelpAccepted(0, "Usage: pkg-config [OPTION...]")).toBe(true);
    expect(pkgConfigHelpAccepted(0, "This is pkg-config (Pure-Perl implementation)")).toBe(false);
    expect(pkgConfigHelpAccepted(1, "Usage: pkg-config [OPTION...]")).toBe(false);
    // A probe killed by its timeout reports a null exit code; that is not a
    // zero exit, and the validator would not have seen one either.
    expect(pkgConfigHelpAccepted(null, "")).toBe(false);
  });

  it("starts a batch candidate through the command interpreter", () => {
    // Node cannot spawn a `.bat` itself: `CreateProcess` refuses it and Node
    // raises `EINVAL`. The Windows source gate found that when the probe first
    // started one directly, so a candidate CMake can run is started the way
    // Windows runs a batch file — through cmd, with the command quoted as `/s`
    // expects.
    const bat = probeInvocation("C:\\tools\\pkg-config.bat", "--help", true);
    expect(bat.command).toMatch(/cmd(?:\.exe)?$/iu);
    expect(bat.args).toEqual(["/d", "/s", "/c", '"C:\\tools\\pkg-config.bat" --help']);

    // An executable image is started directly, with the flag as its own
    // argument — no interpreter and no shell quoting in between.
    expect(probeInvocation("C:\\tools\\pkg-config.exe", "--version", true)).toEqual({
      command: "C:\\tools\\pkg-config.exe",
      args: ["--version"],
    });

    // Off Windows a `.bat` is just a file name; nothing wraps it.
    expect(probeInvocation("/opt/bin/pkg-config.bat", "--version", false)).toEqual({
      command: "/opt/bin/pkg-config.bat",
      args: ["--version"],
    });
  });
});

describe("the msbuild generator", () => {
  it.skipIf(!isWindows)(
    isWindows
      ? "does not pin the Visual Studio generator to a version"
      : "does not pin the Visual Studio generator to a version — skipped: not a Windows host",
    async () => {
      const seen: RunProcessOptions[] = [];
      const scripted = new LocalToolchainProvider({
        run: async (options) => {
          seen.push(options);
          return await syntheticRun(options);
        },
      });

      await scripted.createClient().build({
        workspacePath,
        buildDir,
        buildType: "Release",
        generator: "msbuild",
        clean: false,
        timeoutMs: 60_000,
        configureOnly: true,
        libuvcppPrefix: otherPrefix,
        signal,
      });

      const configure = seen[0]?.args ?? [];
      // `-G "Visual Studio 17 2022"` fails on VS 2019 and on the VS 18 runner.
      // CMake's default on Windows is the installed Visual Studio, so the
      // configure must not name a version at all.
      expect(configure).not.toContain("-G");
      expect(configure).not.toContain("Visual Studio 17 2022");
      expect(configure).toContain("-DCMAKE_BUILD_TYPE=Release");
    },
  );

  it.skipIf(isWindows)(
    isWindows
      ? "refuses msbuild off Windows — skipped: this is a Windows host"
      : "refuses msbuild off Windows with unsupported_toolchain",
    async () => {
      const failure = await failureOf(() =>
        provider.createClient().build({
          workspacePath,
          buildDir,
          buildType: "Release",
          generator: "msbuild",
          clean: false,
          timeoutMs: 60_000,
          configureOnly: true,
          libuvcppPrefix: otherPrefix,
          signal,
        }),
      );

      expect(failure.code).toBe("unsupported_toolchain");
      expect(failure.remediation.action).toContain("ninja");
    },
  );
});
