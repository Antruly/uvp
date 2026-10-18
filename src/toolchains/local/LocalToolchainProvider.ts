import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import type {
  BuildDiagnostic,
  BuildOutcome,
  BuildRequest,
  BuildSystemDescriptor,
  CompilerDescriptor,
  LibuvcppBuild,
  ToolchainAvailability,
  ToolchainClient,
  ToolchainIdentity,
  ToolchainProvider,
} from "../../application/ToolchainProvider.js";
import { UvpFailure, cancelledFailure } from "../../domain/errors.js";
import { discoverArtifacts } from "../artifacts.js";
import { buildOutputEnvironment, noWorkWasDone, parseDiagnostics } from "../diagnostics.js";
import { configHeaderPaths, modulesFromConfigHeader } from "../libuvcppConfig.js";
import { findOnPath, isWindows, versionOf, whichOnPath } from "../host.js";
import { runProcess } from "../processRunner.js";
import type { ProcessOutcome, RunProcessOptions } from "../processRunner.js";

/**
 * What a cancelled inspection, discovery, or build reports.
 *
 * Module constants rather than strings at each site: the same cancellation is
 * noticed in two loops of one function, and two spellings of one finding is how
 * a caller ends up matching on messages that only sometimes agree.
 */
const INSPECTION_CANCELLED =
  "The toolchain inspection was cancelled before it finished, so what this host has is unknown.";
const DISCOVERY_CANCELLED =
  "The libuvcpp search was cancelled before it finished, so whether one is installed is unknown.";
const BUILD_CANCELLED =
  "The build was cancelled before it finished, so it says nothing about whether this workspace compiles.";

const COMPILER_CANDIDATES: readonly { id: string; commands: readonly string[] }[] = isWindows
  ? [
      { id: "msvc", commands: ["cl"] },
      { id: "clang", commands: ["clang++", "clang"] },
      { id: "gcc", commands: ["g++", "gcc"] },
    ]
  : [
      { id: "clang", commands: ["clang++", "clang"] },
      { id: "gcc", commands: ["g++", "gcc"] },
      { id: "cc", commands: ["c++", "cc"] },
    ];

/**
 * Where Visual Studio's own locator lives, in the order to try it.
 *
 * `vswhere.exe` is installed by the Visual Studio installer and answers "which
 * C++ toolset is installed" without a Developer Command Prompt — the one
 * question a `PATH` probe cannot answer for MSVC, because `cl.exe` is only on
 * `PATH` after `vcvarsall.bat` has run. The 32-bit installer puts it under
 * `ProgramFiles(x86)` even on a 64-bit-only install, so both roots are tried.
 *
 * Pure, so the list can be pinned without a Windows host.
 */
export const vsWhereCandidates = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] => {
  const roots = [env["ProgramFiles(x86)"], env["ProgramFiles"]];
  const paths = roots.flatMap((root) =>
    root === undefined || root === ""
      ? []
      : [join(root, "Microsoft Visual Studio", "Installer", "vswhere.exe")],
  );
  return [...new Set(paths)];
};

/**
 * One toolset `vswhere -find` named, with the parts that decide which wins.
 *
 * Matched rather than trusted line by line: vswhere prints a banner on stdout,
 * and a parser that took the first line would hand back "Visual Studio Locator
 * version 3.1.7" as a compiler path.
 */
const MSVC_TOOLSET =
  /[\\/]VC[\\/]Tools[\\/]MSVC[\\/](\d+(?:\.\d+)*)[\\/]bin[\\/](Host[A-Za-z0-9]+)[\\/]([A-Za-z0-9]+)[\\/]cl\.exe$/iu;

const versionParts = (version: string): readonly number[] => version.split(".").map(Number);

const compareVersionParts = (left: readonly number[], right: readonly number[]): number => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * The toolset to report when the locator named several.
 *
 * A host-x64 compiler producing x64 code is what CMake's Visual Studio generator
 * uses by default, so it wins; the highest `MSVC\<version>` wins next, because
 * an install keeps the previous toolset beside the current one; the path is the
 * last tie-break so the answer is stable rather than dependent on output order.
 *
 * Pure: the ranking is the part that can be wrong, and it is testable on any
 * host even though the command that produces the lines needs Windows.
 */
export const chooseMsvcToolset = (stdout: string): string | undefined => {
  const found = stdout.split(/\r?\n/u).flatMap((line) => {
    const path = line.trim();
    const match = MSVC_TOOLSET.exec(path);
    return match === null
      ? []
      : [
          {
            path,
            version: versionParts(match[1] ?? "0"),
            host: (match[2] ?? "").toLowerCase(),
            target: (match[3] ?? "").toLowerCase(),
          },
        ];
  });
  const rank = (entry: (typeof found)[number]): number =>
    entry.target === "x64" ? (entry.host === "hostx64" ? 2 : 1) : 0;
  const [best] = [...found].sort(
    (left, right) =>
      rank(right) - rank(left) ||
      compareVersionParts(right.version, left.version) ||
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  return best?.path;
};

/**
 * How long the locator may take before the probe gives up.
 *
 * Ten seconds was not enough on a cold GitHub-hosted Windows runner: the first
 * .NET start of `vswhere` there was killed at exactly 10 000 ms, and the
 * Windows source lane read that as a host with no compiler ([PR
 * #229](https://github.com/Antruly/uvp/pull/229)). Thirty seconds keeps the
 * wait bounded while leaving a cold, virus-scanned first start room to finish;
 * a warm answer takes milliseconds.
 */
const VSWHERE_TIMEOUT_MS = 30_000;

/** Why the locator did not name a toolset. */
export type MsvcLocatorProblem =
  | "no-locator"
  | "named-nothing"
  | "timed-out"
  | "could-not-start"
  | "failed";

/**
 * What asking the Visual Studio locator established.
 *
 * `no-locator` and `named-nothing` are observations that no MSVC was found: the
 * installer put no locator at either root, or the locator answered and named
 * none. The other three are the locator not answering, which is a different
 * fact — "I could not look" must not become `missing: compiler`.
 */
export type MsvcLocatorResult =
  | { readonly path: string }
  | { readonly problem: MsvcLocatorProblem };

/** How `locateMsvcToolset` starts `vswhere`; a seam for tests without a locator. */
export type VsWhereRunner = (
  executable: string,
  args: readonly string[],
) => Promise<
  { readonly stdout: string } | { readonly problem: "timed-out" | "could-not-start" | "failed" }
>;

const runVsWhere: VsWhereRunner = async (executable, args) => {
  let outcome: ProcessOutcome;
  try {
    outcome = await runProcess({ command: executable, args, timeoutMs: VSWHERE_TIMEOUT_MS });
  } catch {
    return { problem: "could-not-start" };
  }
  if (outcome.timedOut) return { problem: "timed-out" };
  if (outcome.exitCode !== 0) return { problem: "failed" };
  return { stdout: outcome.stdout };
};

/**
 * Ask Visual Studio where its C++ toolset is, without a Developer Command Prompt.
 *
 * `-latest` asks the newest install and `-find` makes vswhere do the directory
 * walk, so this does not encode where Microsoft keeps toolsets. Nothing beyond
 * those long-standing options is passed: a flag an older vswhere does not know
 * makes it print usage instead of paths. That is also why the banner it prints
 * by default is filtered by shape rather than suppressed with `-nologo`.
 */
const VS_WHERE_ARGS: readonly string[] = [
  "-latest",
  "-products",
  "*",
  "-requires",
  "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
  "-find",
  "VC\\Tools\\MSVC\\**\\bin\\Host*\\*\\cl.exe",
];

export const locateMsvcToolset = async (
  windows: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
  run: VsWhereRunner = runVsWhere,
): Promise<MsvcLocatorResult> => {
  if (!windows) return { problem: "no-locator" };
  for (const candidate of vsWhereCandidates(env)) {
    try {
      await access(candidate, constants.X_OK);
    } catch {
      // No installer locator at this root; try the other one.
      continue;
    }
    // This root has the locator, so this is the installer that would know. A
    // second root would ask the same installer again and, after a timeout,
    // spend the whole budget twice.
    const answer = await run(candidate, VS_WHERE_ARGS);
    if ("problem" in answer) return { problem: answer.problem };
    const chosen = chooseMsvcToolset(answer.stdout);
    return chosen === undefined ? { problem: "named-nothing" } : { path: chosen };
  }
  return { problem: "no-locator" };
};

const BUILD_SYSTEM_CANDIDATES: readonly { id: string; commands: readonly string[] }[] = [
  { id: "cmake", commands: ["cmake"] },
  { id: "ninja", commands: ["ninja"] },
  { id: "make", commands: ["make", "gmake"] },
];

/**
 * From CMake 3.22, `FindPkgConfig` searches `pkgconf` as well as `pkg-config`.
 * 3.20 and 3.21 list `pkg-config` only.
 */
const PKGCONF_CMake_MINOR = 22;

/**
 * From CMake 3.29.1, `find_program` on Windows validates a non-`.exe` candidate
 * by running it with `--help` and rejecting an exit other than 0 or output
 * containing `Pure-Perl` — Strawberry Perl's shim. The gate is the patch release,
 * not 3.30: 3.29.0 has no validator, and 3.29.1 through 3.29.6 have the same one
 * 3.30 does. Before it every candidate `find_program` returned was accepted by
 * the same `--version` check that still follows it in every version.
 */
const BAT_VALIDATOR_CMake_VERSION: readonly [number, number, number] = [3, 29, 1];

/** The `major.minor[.patch]` CMake reports, or undefined when the line is not one. */
const cmakeVersionParts = (
  version: string | undefined,
): readonly [number, number, number] | undefined => {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/u.exec(version ?? "");
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
};

/** Whether the version CMake reports is at or above `required`. */
const cmakeAtLeast = (
  version: string | undefined,
  required: readonly [number, number, number],
): boolean => {
  const parsed = cmakeVersionParts(version);
  // An unreadable version takes the broader branch on purpose: reporting a tool
  // CMake may use is a weaker error than requiring one the caller may not need.
  if (parsed === undefined) return true;
  const [major, minor, patch] = parsed;
  const [wantMajor, wantMinor, wantPatch] = required;
  if (major !== wantMajor) return major > wantMajor;
  if (minor !== wantMinor) return minor > wantMinor;
  return patch >= wantPatch;
};

/**
 * The names CMake's `FindPkgConfig` searches, in the order it searches them.
 *
 * Windows lists `pkg-config.bat` first — both since 3.20, and still in 3.31 —
 * so that name is tried before the executable image. The list is version-gated
 * for `pkgconf` because CMake 3.20 and 3.21 do not know it at all: a host with
 * only `pkgconf` is not ready there, and saying it is would move the failure to
 * the caller's configure.
 *
 * The list is an approximation in one respect: CMake 3.22 prepends `pkgconf`
 * ahead of `pkg-config`, and 3.23 through 3.31 append it. That only decides
 * which path is named when both are installed, not whether a host is ready.
 */
export const pkgConfigCandidateNames = (
  cmakeVersion: string | undefined,
  windows: boolean = isWindows,
): readonly string[] => {
  const names: string[] = [];
  if (windows) names.push("pkg-config.bat");
  names.push(windows ? "pkg-config.exe" : "pkg-config");
  if (cmakeAtLeast(cmakeVersion, [3, PKGCONF_CMake_MINOR, 0])) {
    names.push(windows ? "pkgconf.exe" : "pkgconf");
  }
  return names;
};

/**
 * CMake's Windows validator for a non-`.exe` candidate (3.29.1+), as a predicate.
 *
 * `execute_process(COMMAND "${candidate}" --help ...)` and then
 * `if(NOT _result EQUAL 0 OR _output MATCHES "Pure-Perl")`. The output variable
 * collects stderr as well, so both streams are searched here.
 */
export const pkgConfigHelpAccepted = (exitCode: number | null, output: string): boolean =>
  exitCode === 0 && !/Pure-Perl/u.test(output);

/**
 * Whether the version in use runs that validator at all.
 *
 * Exported because it is the boundary that decides *when* a candidate is
 * rejected, and it is not visible in `pkgConfigHelpAccepted`'s tests: a probe
 * that skipped the check entirely would still pass every one of them. CMake
 * 3.29.0 and earlier search the same names and accept whatever `find_program`
 * finds, so a host whose only shim is rejected from 3.29.1 on is ready there.
 */
export const pkgConfigValidatesCandidate = (
  cmakeVersion: string | undefined,
  windows: boolean = isWindows,
): boolean => windows && cmakeAtLeast(cmakeVersion, BAT_VALIDATOR_CMake_VERSION);

/**
 * How to start `path` for a probe.
 *
 * A `.bat` is a script for the command interpreter, not an executable image:
 * `CreateProcess` refuses it and Node reports `EINVAL`, so a shim CMake's
 * module can run is not automatically one this probe can. Windows starts a
 * batch file through `cmd /d /s /c` with the path quoted; everything else is
 * started directly. `/s` makes cmd strip the outer quotes of the single `/c`
 * argument, which is why the command is one string.
 */
export const probeInvocation = (
  path: string,
  flag: string,
  windows: boolean = isWindows,
): { readonly command: string; readonly args: readonly string[] } =>
  windows && /\.(?:bat|cmd)$/iu.test(path)
    ? {
        command: process.env["ComSpec"] ?? "cmd.exe",
        args: ["/d", "/s", "/c", `"${path}" ${flag}`],
      }
    : { command: path, args: [flag] };

const answersVersion = async (path: string, signal: AbortSignal): Promise<boolean> => {
  const probe = await runProcess({
    ...probeInvocation(path, "--version"),
    timeoutMs: 10_000,
    signal,
  });
  return probe.exitCode === 0;
};

const helpAccepts = async (path: string, signal: AbortSignal): Promise<boolean> => {
  const probe = await runProcess({
    ...probeInvocation(path, "--help"),
    timeoutMs: 10_000,
    signal,
  });
  return pkgConfigHelpAccepted(probe.exitCode, `${probe.stdout}${probe.stderr}`);
};

/**
 * The pkg-config executable CMake will actually use, or a negative answer.
 *
 * uvp mirrors `FindPkgConfig` rather than approximating it with an `.exe`-only
 * lookup: on Windows the module searches `pkg-config.bat` first, so a host whose
 * shim is a working `.bat` is ready even though no `.exe` exists. From 3.29.1
 * the module's validator rejects a non-`.exe` that fails `--help` or identifies
 * as Pure-Perl, and its search then continues with the rest of the list; older
 * versions accept any candidate `find_program` returns and decide with
 * `--version`, which every version still runs afterwards and which clears the
 * result on a nonzero exit.
 *
 * `{}` means "looked and found nothing CMake would use"; the caller decides
 * whether that is a problem, because whether a build needs pkg-config depends on
 * the libuvcpp route it resolved to.
 */
const pkgConfigOnPath = async (
  signal: AbortSignal,
  cmakeVersion: string | undefined,
): Promise<{ readonly path?: string }> => {
  if (signal.aborted) throw cancelledFailure(INSPECTION_CANCELLED);
  const names = pkgConfigCandidateNames(cmakeVersion);
  let candidate = await findOnPath(names);
  if (
    candidate !== undefined &&
    pkgConfigValidatesCandidate(cmakeVersion) &&
    !candidate.toLowerCase().endsWith(".exe") &&
    !(await helpAccepts(candidate, signal))
  ) {
    // The validator rejected this candidate, and `find_program` keeps looking
    // through the rest of the list rather than failing the package lookup.
    candidate = await findOnPath(names.slice(names[0] === "pkg-config.bat" ? 1 : 0));
  }
  if (candidate === undefined) return {};
  if (signal.aborted) throw cancelledFailure(INSPECTION_CANCELLED);
  return (await answersVersion(candidate, signal)) ? { path: candidate } : {};
};

/**
 * The entries of `CMAKE_PREFIX_PATH`, in the spellings a caller may have used.
 *
 * CMake uses `:` on UNIX and `;` on Windows; both are accepted here because
 * callers write either. This repository's installation guide uses the POSIX
 * spelling:
 *
 *     export CMAKE_PREFIX_PATH="$HOME/.local:$CMAKE_PREFIX_PATH"
 *
 * Before [#80](https://github.com/Antruly/uvp/issues/80) the whole value was
 * pushed into the search roots as one directory, so a caller with two prefixes
 * was told no libuvcpp was installed even when one entry held a complete install.
 * Windows is split on `;` only: every absolute Windows path starts with a drive
 * letter, and splitting on `:` would turn `C:\prefix` into `C` and `\prefix`.
 *
 * Empty entries are dropped rather than searched. A trailing separator is how a
 * shell writes "the variable was empty", and an empty string is not a directory
 * named "".
 */
const pathListEntries = (value: string | undefined): readonly string[] => {
  if (value === undefined) return [];
  return (isWindows ? value.split(";") : value.split(/[;:]/u))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
};

/**
 * Candidate roots for a libuvcpp installation.
 *
 * The environment variables come first because they are how a caller pins a
 * specific build; the directory scan is a convenience for the common case where
 * someone unpacked a release there.
 *
 * The roots are deduplicated because the same prefix can arrive through more than
 * one variable — a caller who sets both `UVCPP_ROOT` and `CMAKE_PREFIX_PATH` is
 * not asking for the install to be examined twice — and searching it twice would
 * report the same directory as two candidates.
 */
const libuvcppSearchRoots = (workspacePath: string | undefined): readonly string[] => {
  const fromEnv = [
    process.env["UVCPP_ROOT"],
    process.env["LIBUVCPP_ROOT"],
    ...pathListEntries(process.env["CMAKE_PREFIX_PATH"]),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const conventional = [
    "/usr/local",
    "/usr",
    "/opt/libuvcpp",
    join(tmpdir(), "libuvcpp"),
    workspacePath === undefined ? undefined : join(workspacePath, "third_party", "libuvcpp"),
    workspacePath === undefined ? undefined : join(workspacePath, "vendor", "libuvcpp"),
    ...(isWindows && process.env["ProgramFiles"] !== undefined
      ? [join(process.env["ProgramFiles"], "libuvcpp")]
      : []),
  ].filter((value): value is string => value !== undefined);

  return [...new Set([...fromEnv, ...conventional])];
};

/**
 * Read the feature set out of a build's generated config header.
 *
 * The layouts to try and the rule for reading the text live in
 * `toolchains/libuvcppConfig.ts`, because a provider that runs its build
 * somewhere else reads the *same* header and must reach the same answer. What is
 * local here is only the file read.
 */
const readModules = async (installPrefix: string): Promise<readonly string[] | undefined> => {
  for (const candidate of configHeaderPaths(installPrefix)) {
    try {
      return modulesFromConfigHeader(await readFile(candidate, "utf8"));
    } catch {
      // Try the next candidate layout.
    }
  }
  // No layout could be read. `undefined` rather than `[]`: an empty list is the
  // finding "read it, and it defines no modules", and returning one here would
  // make a header that was never opened indistinguishable from that finding.
  return undefined;
};

/**
 * The environment a CMake configure needs to find a specific libuvcpp.
 *
 * Both routes, because libuvcpp ships two ways and the generated `CMakeLists.txt`
 * tries them in order: `CMAKE_PREFIX_PATH` for a `cmake --install`ed prefix, and
 * `PKG_CONFIG_PATH` for a prebuilt archive, which ships a `.pc` file and no CMake
 * package config at all. Setting only the first would leave every prebuilt
 * library unfindable, and setting only the second would fail for a
 * `find_package(uvcpp CONFIG)` that never reaches the pkg-config fallback.
 *
 * The existing values are appended rather than replaced: a caller who put
 * something on `CMAKE_PREFIX_PATH` for their own dependency should still get it.
 * `delimiter` is `;` on Windows and `:` elsewhere, and using it is the difference
 * between a working path list and one long directory name.
 */
const prefixEnvironment = (prefix: string): Record<string, string> => {
  const lib = join(prefix, "lib", "pkgconfig");
  const lib64 = join(prefix, "lib64", "pkgconfig");
  return {
    CMAKE_PREFIX_PATH: extendPathList(process.env["CMAKE_PREFIX_PATH"], [prefix]),
    PKG_CONFIG_PATH: extendPathList(process.env["PKG_CONFIG_PATH"], [lib, lib64]),
  };
};

/**
 * The environment every build subprocess gets: the prefix, on top of the one the
 * output's formats are written for.
 *
 * Both halves are always present, and that is the point of doing it here. The
 * locale half was missing from the compile until a link failure was reported as
 * nothing: `cmake --configure` sets the prefix and `cmake --build` sets nothing,
 * so a localized host's linker message and Make's own words were the ones the
 * parser saw last and understood least. `buildOutputEnvironment` carries the
 * measurement and the reason. The prefix half is conditional only because a
 * caller may have named no prefix and discovery may have found none, and inventing
 * one would point CMake at a directory that does not exist.
 */
const buildEnvironment = (prefix: string | undefined): Readonly<Record<string, string>> => ({
  ...buildOutputEnvironment(),
  ...(prefix === undefined ? {} : prefixEnvironment(prefix)),
});

const extendPathList = (existing: string | undefined, entries: readonly string[]): string => {
  const kept = (existing ?? "").split(delimiter).filter((entry) => entry !== "");
  return [...entries, ...kept].join(delimiter);
};

/**
 * Where a libuvcpp version can be read from, most authoritative first.
 *
 * The `.pc` entry is not optional decoration. A prebuilt release archive ships
 * `lib/pkgconfig/uvcpp.pc` and **no** CMake package config at all — so without it
 * every prebuilt install reports `version unknown`, which is exactly the case a
 * caller is most likely to be using. The three sources can disagree (a prefix
 * holding two installs, one built from source over another), so which one
 * answered is carried out alongside the number rather than thrown away.
 */
type LibuvcppVersionSource = "cmake_package" | "pkgconfig" | "version_file";

const VERSION_SOURCES: readonly { source: LibuvcppVersionSource; path: readonly string[] }[] = [
  { source: "cmake_package", path: ["lib", "cmake", "uvcpp", "uvcppConfigVersion.cmake"] },
  { source: "cmake_package", path: ["lib64", "cmake", "uvcpp", "uvcppConfigVersion.cmake"] },
  { source: "pkgconfig", path: ["lib", "pkgconfig", "uvcpp.pc"] },
  { source: "pkgconfig", path: ["lib64", "pkgconfig", "uvcpp.pc"] },
  { source: "version_file", path: ["share", "uvcpp", "version"] },
];

const libuvcppVersionOf = async (
  installPrefix: string,
): Promise<{ version: string; source: LibuvcppVersionSource } | undefined> => {
  for (const { source, path } of VERSION_SOURCES) {
    let text: string;
    try {
      text = await readFile(join(installPrefix, ...path), "utf8");
    } catch {
      continue;
    }
    // A `.pc` file's `Version:` is plain; a CMake config file quotes the value.
    // `bare` is the form a bare version file holds and is deliberately last.
    const match =
      /PACKAGE_VERSION\s+"([^"]+)"/u.exec(text) ??
      /^\s*Version\s*:\s*(\S+)/mu.exec(text) ??
      /^\s*(\d+\.\d+\.\d+\S*)\s*$/mu.exec(text);
    if (match?.[1] !== undefined) return { version: match[1], source };
  }
  return undefined;
};

const generatorArgs = (generator: BuildRequest["generator"]): readonly string[] => {
  switch (generator) {
    case "ninja":
      return ["-G", "Ninja"];
    case "unix-makefiles":
      return ["-G", "Unix Makefiles"];
    case "msbuild":
      // The versioned name was hardcoded to "Visual Studio 17 2022", which fails
      // on VS 2019 and on the VS 18 runner. CMake's default generator on Windows
      // is the installed Visual Studio, so omitting `-G`/`-A` follows the host
      // instead of a version fixed at authoring time. The client rejects the flag
      // off Windows rather than handing CMake a Windows generator.
      return [];
    default:
      return [];
  }
};

/**
 * How a local build starts `cmake`.
 *
 * A seam, not a second implementation: the default is `runProcess`, and the
 * only caller that replaces it is a test that cannot start the process it would
 * otherwise start. `ContainerToolchainProvider` has the same shape for the same
 * reason, and this one was left out until a Windows lane needed it for real
 * ([#11](https://github.com/Antruly/uvp/issues/11)).
 *
 * The limit it exists for is measured rather than imagined. The provider chooses
 * `cmake`'s argv itself, so on Windows the suite's `cmake` stand-in is a copy of
 * Node, and Node reads `-S`/`--build` as its own bad options before any of the
 * suite's code runs — `node: bad option: -S`, exit 9, nothing imported. A test
 * that injects this runner observes the command the provider would run without
 * pretending a Node copy accepted it. [#22](https://github.com/Antruly/uvp/issues/22)
 * records the original finding.
 */
export type LocalRunSlot = (options: RunProcessOptions) => Promise<ProcessOutcome>;

/** What a local provider may be given besides the host it reads. */
export interface LocalProviderOptions {
  /** Replaces the process runner; the default is `runProcess`. */
  readonly run?: LocalRunSlot;
  /**
   * Replaces the Visual Studio locator query; the default asks `vswhere`.
   *
   * A seam like `run`, for the same reason: what the provider does with each
   * answer is the part that can be wrong, and a host without Visual Studio
   * cannot produce a timeout, a refused start, or a locator that names nothing.
   */
  readonly locateMsvc?: (windows: boolean) => Promise<MsvcLocatorResult>;
}

/**
 * The local toolchain.
 *
 * Synchronous, on this machine, with the caller's own compiler. This is the
 * provider that must work before any other provider is worth adding, because it
 * is the one a user has when they have nothing else.
 */
export class LocalToolchainProvider implements ToolchainProvider {
  constructor(private readonly options: LocalProviderOptions = {}) {}

  identity(): ToolchainIdentity {
    return { id: "local", platform: `${process.platform}-${process.arch}` };
  }

  async inspectAvailability(signal: AbortSignal): Promise<ToolchainAvailability> {
    const compilers: CompilerDescriptor[] = [];
    const missing: { id: string; requiredFor: string }[] = [];

    for (const candidate of COMPILER_CANDIDATES) {
      // A cancelled inspection says so rather than returning what it had
      // collected: a partial compiler list is an empty one when the loop is
      // interrupted at the first candidate, and an empty list is what makes
      // `available` false — so the caller would be told this host has no C++
      // compiler because they pressed Ctrl-C.
      if (signal.aborted) throw cancelledFailure(INSPECTION_CANCELLED);
      for (const command of candidate.commands) {
        const path = await whichOnPath(command);
        if (path === undefined) continue;
        const version = await versionOf(path, ["--version"]);
        compilers.push({
          id: candidate.id,
          path,
          onPath: true,
          ...(version === undefined ? {} : { version }),
        });
        break;
      }
    }
    // A PATH-only probe cannot see an MSVC that is installed and reachable from
    // a Developer Command Prompt but not from here. On Windows, ask Visual
    // Studio's locator before turning "the probe found nothing" into "this host
    // has no compiler" — [#224](https://github.com/Antruly/uvp/issues/224).
    // Off Windows the platform has no such split to model: a compiler that is
    // not on PATH is not one `cmake` can find either. A locator that could not
    // answer is a third state: it is a limitation saying the question is open,
    // not a `missing` entry claiming the compiler is absent.
    let msvcOffPath: string | undefined;
    let locatorUnanswered: MsvcLocatorProblem | undefined;
    if (compilers.length === 0 && isWindows) {
      if (signal.aborted) throw cancelledFailure(INSPECTION_CANCELLED);
      const locateMsvc = this.options.locateMsvc ?? locateMsvcToolset;
      const located = await locateMsvc(isWindows);
      if ("path" in located) {
        msvcOffPath = located.path;
        // Located, not assumed runnable. The version is asked for separately and
        // may stay unknown; what `onPath: false` records is where the file is.
        const version = await versionOf(msvcOffPath, []);
        compilers.push({
          id: "msvc",
          path: msvcOffPath,
          onPath: false,
          ...(version === undefined ? {} : { version }),
        });
      } else if (located.problem !== "no-locator" && located.problem !== "named-nothing") {
        // The locator exists but did not answer. Whether an MSVC is installed is
        // therefore unknown, not absent: `missing: compiler` would turn "I could
        // not look" into "this host cannot compile".
        locatorUnanswered = located.problem;
      }
    }
    if (compilers.length === 0 && locatorUnanswered === undefined) {
      missing.push({ id: "compiler", requiredFor: "building any C++ target" });
    }

    const buildSystems: BuildSystemDescriptor[] = [];
    for (const candidate of BUILD_SYSTEM_CANDIDATES) {
      if (signal.aborted) throw cancelledFailure(INSPECTION_CANCELLED);
      for (const command of candidate.commands) {
        const path = await whichOnPath(command);
        if (path === undefined) continue;
        const version = await versionOf(path, ["--version"]);
        buildSystems.push({
          id: candidate.id,
          path,
          ...(version === undefined ? {} : { version }),
        });
        break;
      }
    }
    if (!buildSystems.some((system) => system.id === "cmake")) {
      missing.push({ id: "cmake", requiredFor: "configuring a uvp workspace" });
    }
    if (!buildSystems.some((system) => system.id === "ninja")) {
      missing.push({
        id: "ninja",
        requiredFor: "the faster generator; make will be used instead if present",
      });
    }

    const limitations: string[] = [];
    if (buildSystems.some((system) => system.id === "ninja") === false) {
      limitations.push("Ninja is absent; incremental rebuilds will be slower than they could be.");
    }
    if (compilers.length > 0 && compilers[0] !== undefined) {
      limitations.push(`Default compiler is ${compilers[0].id}; pass a generator to override.`);
    }
    if (msvcOffPath !== undefined) {
      limitations.push(
        `MSVC is installed at ${msvcOffPath} but is not on PATH, because Visual Studio only ` +
          "puts it there in a Developer Command Prompt. CMake's Visual Studio generator builds " +
          "with it; a generator that runs the compiler directly needs a Developer Command " +
          "Prompt (run vcvarsall.bat) or a shell that has already run it.",
      );
    }
    if (locatorUnanswered !== undefined) {
      limitations.push(
        locatorUnanswered === "timed-out"
          ? "Visual Studio's locator did not answer in time, so whether an MSVC toolset is " +
              "installed is unknown; a Developer Command Prompt has cl.exe on PATH."
          : locatorUnanswered === "could-not-start"
            ? "Visual Studio's locator could not be started, so whether an MSVC toolset is " +
              "installed is unknown."
            : "Visual Studio's locator exited without naming a toolset, so whether an MSVC " +
              "toolset is installed is unknown.",
      );
    }

    // Looked for, not required. Whether a build needs pkg-config depends on the
    // libuvcpp route — an install with a CMake package never reaches the
    // fallback — and that is a fact about the library, decided by the caller
    // once discovery has answered. The CMake version is read from the descriptor
    // above rather than probed again: the names and validator CMake's own module
    // uses are version-dependent, so the probe has to search what that version
    // searches.
    const cmakeVersion = buildSystems.find((system) => system.id === "cmake")?.version;
    const pkgConfig = await pkgConfigOnPath(signal, cmakeVersion);
    return {
      id: "local",
      available: compilers.length > 0 && buildSystems.some((s) => s.id === "cmake"),
      ...(cmakeVersion === undefined ? {} : { version: cmakeVersion }),
      compilers,
      buildSystems,
      missing,
      limitations,
      pkgConfig,
    };
  }

  async findLibuvcpp(
    workspacePath: string | undefined,
    signal: AbortSignal,
  ): Promise<LibuvcppBuild> {
    return await findLibuvcpp(workspacePath, signal);
  }

  createClient(): ToolchainClient {
    return new LocalToolchainClient(this.identity(), this.options.run ?? runProcess);
  }
}

/**
 * Which libuvcpp this machine has, and what that build supports.
 *
 * A module-level function rather than a method so the *build* can consult it
 * too: the tools that report on a library and the build that compiles against
 * one have to answer from the same place, or they answer differently. They did —
 * `uvp build` discovered the install and passed its prefix to CMake, while
 * `uvp verify`, which builds inside its own workflow, did not, so the whole
 * closure failed on any install that is not already on CMake's search path. A
 * release archive unpacked anywhere the user liked is exactly that case, and is
 * what uvp's own instructions tell a user to do.
 *
 * The first root that has either a `UVCPP_*` config header or a CMake package
 * file under `lib/` or `lib64/` wins, and the search order is the caller's
 * environment first. The note for "found nothing" names the available fixes;
 * when a shared library was found without the files that go with it, it names
 * the library and the development package, because "install libuvcpp" is not
 * useful advice to someone who installed half of it.
 */
const findLibuvcpp = async (
  workspacePath: string | undefined,
  signal: AbortSignal,
): Promise<LibuvcppBuild> => await discoverLibuvcpp(libuvcppSearchRoots(workspacePath), signal);

/**
 * The answer for a list of candidate roots.
 *
 * Separate from the environment lookup so it can be exercised against roots a
 * test controls: the found-nothing branch is only reached when *no* root has an
 * install, and whether a developer's own machine has one under `/usr` is not
 * something a test may depend on. The provider still calls it with the same
 * search roots it always did.
 */
export const discoverLibuvcpp = async (
  roots: readonly string[],
  signal: AbortSignal,
): Promise<LibuvcppBuild> => {
  // The first shared library found under a prefix that has no usable
  // development files. Named in the found-nothing note, because "no libuvcpp
  // installation found" is a misleading answer to someone who installed the
  // runtime package: the library is there, and the package that carries the
  // headers and the CMake package is the thing to install.
  let sharedLibrary: string | undefined;
  for (const root of roots) {
    // Not `found: false`. Every root below could hold an install, and stopping
    // the search at the first one turns "I stopped looking" into "there is
    // nothing here" — with a note in `limitations` that the caller reading
    // `found` has no reason to open. `doctor` renders that as a missing
    // toolchain and tells the user to install a library they may already have.
    if (signal.aborted) throw cancelledFailure(DISCOVERY_CANCELLED);
    try {
      const info = await stat(root);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }
    const modules = await readModules(root);
    // Kept rather than folded into `hasConfig`: the generated project's first
    // route is `find_package(uvcpp CONFIG)`, and whether this install answers
    // it is what decides if pkg-config is a prerequisite. `hasConfig` is the
    // broader question — "does this root hold anything at all" — and answering
    // it by throwing this away would leave the doctor to infer the route from
    // the version-source order.
    const cmakePackage =
      (await cmakePackageIn(root, "lib")) || (await cmakePackageIn(root, "lib64"));
    const hasConfig = (modules?.length ?? 0) > 0 || cmakePackage;
    if (!hasConfig) {
      // A header that was read and defines nothing is not "missing development
      // files"; only a root with no readable config source at all is.
      if (modules === undefined) sharedLibrary ??= await sharedLibraryIn(root);
      continue;
    }
    const version = await libuvcppVersionOf(root);
    return {
      found: true,
      ...(version === undefined ? {} : { version: version.version, versionSource: version.source }),
      installPrefix: root,
      modules: modules ?? [],
      cmakePackage,
      ...(modules === undefined
        ? {
            modulesUnknown: true,
            note: "Found CMake package files but no uvcpp_config.h could be read; module list is unknown.",
          }
        : {}),
    };
  }
  return {
    found: false,
    modules: [],
    note: missingLibuvcppNote(sharedLibrary),
  };
};

/**
 * Whether a prefix carries `find_package(uvcpp CONFIG)`'s package file.
 *
 * Both `lib` and `lib64`: a distribution that installs libraries into `lib64`
 * puts the CMake package there too, and `VERSION_SOURCES` already reads the
 * version from that layout. Checking only `lib` reported such a prefix as
 * missing (libuvcpp's RPM is exactly that shape, where the config header alone
 * happened to answer instead).
 */
const cmakePackageIn = async (root: string, lib: "lib" | "lib64"): Promise<boolean> =>
  await stat(join(root, lib, "cmake", "uvcpp", "uvcppConfig.cmake")).then(
    () => true,
    () => false,
  );

/**
 * The libuvcpp shared library a prefix carries, if it carries one.
 *
 * Distribution packages split the library from the headers: the runtime
 * package in the 1.7.4 release (`libuvcpp1`) installs `libuvcpp.so.1` and
 * `libuvcpp.so.1.7.4` and nothing else. Finding that file is what lets the
 * missing-install note name the thing the caller actually installed.
 */
const SHARED_LIBRARY = /^libuvcpp\.so(\..+)?$/u;

const sharedLibraryIn = async (root: string): Promise<string | undefined> => {
  for (const lib of ["lib", "lib64"]) {
    let entries: readonly string[];
    try {
      entries = await readdir(join(root, lib));
    } catch {
      continue;
    }
    // Sorted so a prefix holding both `libuvcpp.so.1` and `libuvcpp.so.1.7.4`
    // names the same one on every run.
    const found = [...entries].filter((name) => SHARED_LIBRARY.test(name)).sort()[0];
    if (found !== undefined) return join(root, lib, found);
  }
  return undefined;
};

const missingLibuvcppNote = (sharedLibrary: string | undefined): string =>
  sharedLibrary === undefined
    ? "No libuvcpp installation found. Set UVCPP_ROOT, or unpack a release and add its " +
      "prefix to CMAKE_PREFIX_PATH."
    : `Found the libuvcpp shared library at ${sharedLibrary}, but no uvcpp_config.h could ` +
      "be read and no uvcppConfig.cmake was found in the prefixes uvp searches. Install the " +
      "development package (libuvcpp-devel on RPM distributions, libuvcpp-dev on Debian and " +
      "Ubuntu), or unpack a release and add its prefix to CMAKE_PREFIX_PATH.";

class LocalToolchainClient implements ToolchainClient {
  constructor(
    readonly identity: ToolchainIdentity,
    private readonly run: LocalRunSlot,
  ) {}

  async build(request: BuildRequest): Promise<BuildOutcome> {
    // A withdrawn call establishes nothing, so it is `cancelled` before any
    // question about the host or the requested generator is answered.
    if (request.signal.aborted) throw cancelledFailure(BUILD_CANCELLED);
    if (request.generator === "msbuild" && !isWindows) {
      // The same refusal `ContainerToolchainProvider` makes for a Windows build
      // system it cannot run. Without it, the VS flags reach CMake and the
      // caller gets a CMake failure instead of the port's typed answer.
      throw new UvpFailure({
        code: "unsupported_toolchain",
        message: "MSBuild is a Windows build system and cannot run on this host.",
        remediation: { action: "Ask for the ninja or unix-makefiles generator instead." },
      });
    }
    // A caller that named a prefix is taken at its word; otherwise the build
    // uses the install this toolchain found, which is the same answer
    // `uvp doctor` reports. Not a convenience: a build that leaves CMake to
    // search for itself finds nothing for a release archive unpacked anywhere
    // outside the default search paths, which is what the project's own
    // instructions produce. The workflow that builds inside itself — `uvp verify`
    // — passed no prefix, so the whole closure failed at configure for exactly
    // those users while `uvp build`, which did pass one, worked. Deciding here
    // means no caller can forget.
    const libuvcppPrefix =
      request.libuvcppPrefix ??
      (await findLibuvcpp(request.workspacePath, request.signal)).installPrefix;
    const configureStart = Date.now();
    const jobs = request.jobs === undefined ? [] : ["-j", String(request.jobs)];
    const configure = await this.run({
      command: "cmake",
      args: [
        "-S",
        request.workspacePath,
        "-B",
        request.buildDir,
        `-DCMAKE_BUILD_TYPE=${request.buildType}`,
        ...generatorArgs(request.generator),
      ],
      env: buildEnvironment(libuvcppPrefix),
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    const configureDurationMs = Date.now() - configureStart;
    // Before the exit code is read. A configure the caller killed exits
    // non-zero on this host for the ordinary reason — the signal — and an
    // outcome built from that says the workspace does not configure, which is a
    // claim about the code that nothing here observed.
    if (configure.aborted) throw cancelledFailure(BUILD_CANCELLED);

    const commands = [configure.command];
    const diagnostics: BuildDiagnostic[] = [
      ...parseDiagnostics(configure.stdout, configure.stderr, "configure"),
    ];

    if (configure.exitCode !== 0 || request.configureOnly) {
      const succeeded = configure.exitCode === 0;
      return {
        buildDir: request.buildDir,
        exitCode: configure.exitCode ?? -1,
        succeeded,
        configureDurationMs,
        compileDurationMs: 0,
        fromCache: false,
        diagnostics,
        artifacts: succeeded ? await discoverArtifacts(request.buildDir) : [],
        commands,
      };
    }

    const compileStart = Date.now();
    // `--config` is the configuration selector for multi-configuration generators
    // (Visual Studio, Xcode); they ignore `CMAKE_BUILD_TYPE`, which the configure
    // step sets for single-configuration ones. Passing it unconditionally is
    // safe: CMake accepts it with Makefiles and Ninja and keeps the configure's
    // type — measured on this host, configure Debug then
    // `cmake --build build --config Release` exits 0 and builds Debug. Without it,
    // `uvp build --build-type Release` built Debug on the default Windows and
    // macOS generators.
    const buildArgs = ["--build", request.buildDir, "--config", request.buildType, ...jobs];
    if (request.target !== undefined) buildArgs.push("--target", request.target);
    if (request.clean) buildArgs.push("--clean-first");

    const compile = await this.run({
      command: "cmake",
      args: buildArgs,
      // No prefix: `cmake --build` searches for nothing, because the configure
      // already wrote the paths into the build tree. The message locale is a
      // different matter and is set here too — this is the step the compiler and
      // the linker print in, and the step whose output is parsed.
      env: buildOutputEnvironment(),
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    const compileDurationMs = Date.now() - compileStart;
    if (compile.aborted) throw cancelledFailure(BUILD_CANCELLED);
    commands.push(compile.command);
    diagnostics.push(...parseDiagnostics(compile.stdout, compile.stderr, "compile"));

    // Only the no-op phrasings count, which `noWorkWasDone` owns — see there for
    // why `Built target` is deliberately not one of them.
    const combined = `${compile.stdout}\n${compile.stderr}`;
    const fromCache = compile.exitCode === 0 && noWorkWasDone(combined);

    return {
      buildDir: request.buildDir,
      exitCode: compile.exitCode ?? -1,
      succeeded: compile.exitCode === 0,
      configureDurationMs,
      compileDurationMs,
      fromCache,
      diagnostics,
      artifacts: await discoverArtifacts(request.buildDir),
      commands,
    };
  }
}
