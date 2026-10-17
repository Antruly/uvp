import { readFile, stat } from "node:fs/promises";
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
import { cancelledFailure } from "../../domain/errors.js";
import { discoverArtifacts } from "../artifacts.js";
import { buildOutputEnvironment, noWorkWasDone, parseDiagnostics } from "../diagnostics.js";
import { configHeaderPaths, modulesFromConfigHeader } from "../libuvcppConfig.js";
import { isWindows, versionOf, whichOnPath } from "../host.js";
import { runProcess } from "../processRunner.js";

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

const BUILD_SYSTEM_CANDIDATES: readonly { id: string; commands: readonly string[] }[] = [
  { id: "cmake", commands: ["cmake"] },
  { id: "ninja", commands: ["ninja"] },
  { id: "make", commands: ["make", "gmake"] },
];

/**
 * Candidate roots for a libuvcpp installation.
 *
 * The environment variables come first because they are how a caller pins a
 * specific build; the directory scan is a convenience for the common case where
 * someone unpacked a release there.
 */
const libuvcppSearchRoots = (workspacePath: string | undefined): readonly string[] => {
  const fromEnv = [
    process.env["UVCPP_ROOT"],
    process.env["LIBUVCPP_ROOT"],
    process.env["CMAKE_PREFIX_PATH"],
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

  return [...fromEnv, ...conventional];
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
      return ["-G", "Visual Studio 17 2022", "-A", "x64"];
    default:
      return [];
  }
};

/**
 * The local toolchain.
 *
 * Synchronous, on this machine, with the caller's own compiler. This is the
 * provider that must work before any other provider is worth adding, because it
 * is the one a user has when they have nothing else.
 */
export class LocalToolchainProvider implements ToolchainProvider {
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
          ...(version === undefined ? {} : { version }),
        });
        break;
      }
    }
    if (compilers.length === 0) {
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

    const cmakeVersion = await versionOf("cmake", ["--version"]).catch(() => undefined);
    return {
      id: "local",
      available: compilers.length > 0 && buildSystems.some((s) => s.id === "cmake"),
      ...(cmakeVersion === undefined ? {} : { version: cmakeVersion }),
      compilers,
      buildSystems,
      missing,
      limitations,
    };
  }

  async findLibuvcpp(
    workspacePath: string | undefined,
    signal: AbortSignal,
  ): Promise<LibuvcppBuild> {
    return await findLibuvcpp(workspacePath, signal);
  }

  createClient(): ToolchainClient {
    return new LocalToolchainClient(this.identity());
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
 * file wins, and the search order is the caller's environment first. The note
 * for "found nothing" names the two ways to fix that, because that is the only
 * thing a caller can do about it.
 */
const findLibuvcpp = async (
  workspacePath: string | undefined,
  signal: AbortSignal,
): Promise<LibuvcppBuild> => {
  for (const root of libuvcppSearchRoots(workspacePath)) {
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
    const hasConfig =
      (modules?.length ?? 0) > 0 ||
      (await stat(join(root, "lib", "cmake", "uvcpp", "uvcppConfig.cmake")).then(
        () => true,
        () => false,
      ));
    if (!hasConfig) continue;
    const version = await libuvcppVersionOf(root);
    return {
      found: true,
      ...(version === undefined ? {} : { version: version.version, versionSource: version.source }),
      installPrefix: root,
      modules: modules ?? [],
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
    note:
      "No libuvcpp installation found. Set UVCPP_ROOT, or unpack a release and add its " +
      "prefix to CMAKE_PREFIX_PATH.",
  };
};

class LocalToolchainClient implements ToolchainClient {
  constructor(readonly identity: ToolchainIdentity) {}

  async build(request: BuildRequest): Promise<BuildOutcome> {
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
    const configure = await runProcess({
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
    const buildArgs = ["--build", request.buildDir, ...jobs];
    if (request.target !== undefined) buildArgs.push("--target", request.target);
    if (request.clean) buildArgs.push("--clean-first");

    const compile = await runProcess({
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
