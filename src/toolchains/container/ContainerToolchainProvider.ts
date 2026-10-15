import type {
  BuildDiagnostic,
  BuildOutcome,
  BuildRequest,
  BuildSystemDescriptor,
  CompilerDescriptor,
  LibuvcppBuild,
  MissingPrerequisite,
  ToolchainAvailability,
  ToolchainClient,
  ToolchainIdentity,
  ToolchainProvider,
} from "../../application/ToolchainProvider.js";
import { UvpFailure, cancelledFailure } from "../../domain/errors.js";
import { discoverArtifacts } from "../artifacts.js";
import { noWorkWasDone, parseDiagnostics } from "../diagnostics.js";
import { versionOf, whichOnPath } from "../host.js";
import {
  CONFIG_HEADER_RELATIVE_PATHS,
  modulesFromConfigHeader,
  versionFromVersionHeader,
} from "../libuvcppConfig.js";
import { runProcess } from "../processRunner.js";
import type { ProcessOutcome, RunProcessOptions } from "../processRunner.js";

/**
 * Building inside a container image.
 *
 * ## uvp never pulls an image
 *
 * The caller names an image reference and the provider requires it to be present
 * already. Its absence is a per-capability gap, not a reason to reach the
 * network: pulling contacts a registry, and uvp's own roadmap says it does not
 * deploy or publish anything. A tool whose stated scope is "build, run, and
 * verify on your machine" should not acquire a registry credential path as a
 * side effect of being asked to compile C++. A caller who wants an image can
 * fetch it with the runtime's own tooling, where the authority is explicit.
 *
 * ## The workspace is mounted at the same absolute path
 *
 * `docker run -v /a/b:/a/b` rather than `-v /a/b:/work`. Two reasons, and the
 * second is the one that forced it: every path in a `BuildOutcome` — `buildDir`,
 * every diagnostic's `file`, every artifact's `path` — is then valid on the host
 * as well as inside the container, so `discoverArtifacts` reads the real files
 * and a diagnostic points at something the caller can open. Rewriting paths
 * after the fact would be a second interpretation of the same string, which is
 * exactly what the layering rules in this repository keep out.
 *
 * ## What this provider genuinely cannot know
 *
 * Whether a compiler exists inside the image is not knowable from the host, so
 * the provider asks by running the image. That is a container start during
 * `inspectAvailability`, which is why the results say what they are: paths
 * reported for a container's compilers are paths *inside the image* and cannot
 * be executed here. The `limitations` entry says so, because a caller who tried
 * to use one as a host path would get a confusing failure rather than a
 * surprising one.
 */

/** How the provider starts a process, so a test can establish the boundary. */
export type RunSlot = (options: RunProcessOptions) => Promise<ProcessOutcome>;

/** A container runtime uvp knows how to drive, in preference order. */
export interface RuntimeCandidate {
  readonly id: string;
  readonly command: string;
}

/**
 * The runtimes looked for, most common first.
 *
 * These three accept the same `run --rm --mount ... <image> <argv>` shape for
 * everything this provider does, which is why they are one list rather than
 * three implementations. `buildah` is deliberately absent: it builds images and
 * does not `run` them, so listing it would promise a capability it lacks.
 */
export const RUNTIME_CANDIDATES: readonly RuntimeCandidate[] = [
  { id: "docker", command: "docker" },
  { id: "podman", command: "podman" },
  { id: "nerdctl", command: "nerdctl" },
];

/**
 * Linux preference order, which is why it is not `local`'s list.
 *
 * `local` branches on Windows and prefers MSVC there. An image this provider
 * runs is a Linux filesystem by construction, so MSVC cannot appear and a
 * Windows-only ordering would be dead code pretending to be a decision.
 */
const COMPILER_CANDIDATES: readonly { id: string; commands: readonly string[] }[] = [
  { id: "clang", commands: ["clang++", "clang"] },
  { id: "gcc", commands: ["g++", "gcc"] },
  { id: "cc", commands: ["c++", "cc"] },
];

const BUILD_SYSTEM_CANDIDATES: readonly { id: string; commands: readonly string[] }[] = [
  { id: "cmake", commands: ["cmake"] },
  { id: "ninja", commands: ["ninja"] },
  { id: "make", commands: ["make", "gmake"] },
];

/** Prefixes searched inside the image for a libuvcpp install. */
const DEFAULT_IN_IMAGE_PREFIXES: readonly string[] = ["/usr/local", "/usr", "/opt/libuvcpp"];

/**
 * One container start that reports everything this provider needs to know about
 * the image's toolchain.
 *
 * One start rather than six because a container start is the expensive part and
 * the questions are independent. `command -v` is used rather than `which`,
 * because `which` is not present in every image and is not a shell builtin.
 */
const PROBE_SCRIPT = [
  "for c in clang++ clang g++ gcc c++ cc cmake ninja make gmake; do",
  '  p=$(command -v "$c" 2>/dev/null) || continue',
  '  v=$("$c" --version 2>&1 | head -n 1)',
  '  printf "%s\\t%s\\t%s\\n" "$c" "$p" "$v"',
  "done",
].join("\n");

const INSPECTION_CANCELLED =
  "The container toolchain inspection was cancelled before it finished, so what this image has is unknown.";
const DISCOVERY_CANCELLED =
  "The libuvcpp search was cancelled before it finished, so whether one is installed is unknown.";
const BUILD_CANCELLED =
  "The build was cancelled before it finished, so it says nothing about whether this workspace compiles.";

/** Long enough for a cold `run`, short enough not to look like a hang. */
const PROBE_TIMEOUT_MS = 60_000;
const INSPECT_TIMEOUT_MS = 30_000;

export interface ContainerProviderOptions {
  /** The image reference to build in. Must already be present locally. */
  readonly image: string;
  /** Force a runtime binary instead of discovering one. */
  readonly runtime?: string;
  /** Where libuvcpp is installed *inside the image*, when the caller knows. */
  readonly libuvcppPrefix?: string;
  /**
   * How every command this provider starts is started, during a build as well as
   * during an inspection.
   *
   * A seam, and the only reason it exists is that this host has no container
   * runtime: without it the provider could be reviewed but not exercised, and an
   * unexercised provider is one whose command construction nobody has checked.
   * The build is included deliberately rather than left to the real runner —
   * mounts, `--workdir`, and the environment are the parts most worth reading,
   * and a seam that stopped at inspection would leave exactly those unexercised.
   *
   * Tests through this slot establish the boundary; they are not evidence about a
   * real runtime, and they do not claim to be.
   */
  readonly run?: RunSlot;
  /** Override the runtimes searched for, for tests and for a pinned runtime. */
  readonly runtimes?: readonly RuntimeCandidate[];
}

/** A resolved runtime: the one that will be used, and how it announced itself. */
interface ResolvedRuntime {
  readonly id: string;
  readonly path: string;
  readonly version?: string;
}

/**
 * One line of `PROBE_SCRIPT` output: a command, where it is, and its version.
 */
interface ProbedTool {
  readonly name: string;
  readonly path: string;
  readonly version?: string;
}

const parseProbe = (stdout: string): readonly ProbedTool[] => {
  const tools: ProbedTool[] = [];
  for (const line of stdout.split("\n")) {
    const [name, path, version] = line.split("\t");
    if (name === undefined || path === undefined || name === "" || path === "") continue;
    tools.push({
      name,
      path,
      ...(version === undefined || version === "" ? {} : { version }),
    });
  }
  return tools;
};

/**
 * What a set of probed commands amounts to.
 *
 * The preference lists decide which `g++`-or-`gcc` spelling wins and in what
 * order; this turns the flat probe output into the two descriptor lists the port
 * asks for, plus the gaps that follow from them. Pure, so the part that decides
 * what an image "has" is separable from the part that runs it.
 */
const describeTools = (
  tools: readonly ProbedTool[],
): {
  readonly compilers: readonly CompilerDescriptor[];
  readonly buildSystems: readonly BuildSystemDescriptor[];
  readonly missing: readonly MissingPrerequisite[];
} => {
  const pick = (
    candidates: readonly { id: string; commands: readonly string[] }[],
  ): { id: string; path: string; version?: string }[] =>
    candidates.flatMap((candidate) => {
      // `candidate.commands` is an ordered list, so it decides which spelling
      // wins when an image has both — `clang++` over `clang`, `g++` over `gcc`.
      // Searching the probe output instead would hand that decision to whatever
      // order the image's shell loop happened to print, which is a preference
      // nobody expressed. `local` walks the same list in the same order, and two
      // providers disagreeing about which compiler is in use is the kind of
      // difference that surfaces as a build that works in one place and not the
      // other.
      const found = candidate.commands
        .map((command) => tools.find((tool) => tool.name === command))
        .find((tool) => tool !== undefined);
      return found === undefined
        ? []
        : [
            {
              id: candidate.id,
              path: found.path,
              ...(found.version === undefined ? {} : { version: found.version }),
            },
          ];
    });

  const compilers = pick(COMPILER_CANDIDATES);
  const buildSystems = pick(BUILD_SYSTEM_CANDIDATES);
  const missing: MissingPrerequisite[] = [];
  if (compilers.length === 0) {
    missing.push({ id: "compiler", requiredFor: "building any C++ target" });
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
  return { compilers, buildSystems, missing };
};

/** The generators CMake can be asked for inside a Linux image. */
const generatorArgs = (generator: BuildRequest["generator"]): readonly string[] => {
  switch (generator) {
    case "ninja":
      return ["-G", "Ninja"];
    case "unix-makefiles":
      return ["-G", "Unix Makefiles"];
    case "msbuild":
    case undefined:
      return [];
  }
};

export class ContainerToolchainProvider implements ToolchainProvider {
  private runtime: ResolvedRuntime | undefined;

  constructor(private readonly options: ContainerProviderOptions) {}

  /**
   * The image reference travels in `version`.
   *
   * The port has no field for "which toolchain inside a container", and the
   * image is exactly that: the compilers, the CMake, and the libuvcpp are
   * whatever the image says they are, so the image reference identifies the
   * toolchain more precisely than any version number could. It goes in `version`
   * because that is the field a caller sees on a result, and it is not a version
   * — which is why this docblock exists rather than a comment at the return.
   */
  identity(): ToolchainIdentity {
    return { id: "container", platform: "container", version: this.options.image };
  }

  private get run(): RunSlot {
    return this.options.run ?? runProcess;
  }

  /** The first runtime on `PATH`, or `undefined` with nothing started. */
  private async resolveRuntime(signal: AbortSignal): Promise<ResolvedRuntime | undefined> {
    const candidates =
      this.options.runtime === undefined
        ? (this.options.runtimes ?? RUNTIME_CANDIDATES)
        : [{ id: this.options.runtime, command: this.options.runtime }];
    for (const candidate of candidates) {
      if (signal.aborted) throw cancelledFailure(INSPECTION_CANCELLED);
      const path = await whichOnPath(candidate.command);
      if (path === undefined) continue;
      const version = await versionOf(path, ["--version"]);
      return { id: candidate.id, path, ...(version === undefined ? {} : { version }) };
    }
    return undefined;
  }

  /**
   * Which of the named tools the image has, asked by running it.
   *
   * Returns `undefined` when the image could not be run at all, which is not the
   * same answer as "it has none of them" and must not be reported as one.
   */
  private async probeImage(
    runtime: ResolvedRuntime,
    signal: AbortSignal,
  ): Promise<readonly ProbedTool[] | undefined> {
    const outcome = await this.run({
      command: runtime.path,
      args: ["run", "--rm", "--entrypoint", "sh", this.options.image, "-c", PROBE_SCRIPT],
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
    });
    if (outcome.aborted) throw cancelledFailure(INSPECTION_CANCELLED);
    if (outcome.exitCode !== 0) return undefined;
    return parseProbe(outcome.stdout);
  }

  /** Whether the named image is present, without ever contacting a registry. */
  private async imagePresent(runtime: ResolvedRuntime, signal: AbortSignal): Promise<boolean> {
    const outcome = await this.run({
      command: runtime.path,
      args: ["image", "inspect", this.options.image],
      timeoutMs: INSPECT_TIMEOUT_MS,
      signal,
    });
    if (outcome.aborted) throw cancelledFailure(INSPECTION_CANCELLED);
    return outcome.exitCode === 0;
  }

  async inspectAvailability(signal: AbortSignal): Promise<ToolchainAvailability> {
    if (signal.aborted) throw cancelledFailure(INSPECTION_CANCELLED);

    const runtime = await this.resolveRuntime(signal);
    const missing: MissingPrerequisite[] = [];
    const limitations: string[] = [];

    if (runtime === undefined) {
      const looked = (this.options.runtimes ?? RUNTIME_CANDIDATES)
        .map((candidate) => candidate.command)
        .join(", ");
      missing.push({
        id: "container_runtime",
        requiredFor: "running a build inside a container",
      });
      limitations.push(
        `No container runtime was found on PATH (looked for ${looked}), so the image was never examined.`,
      );
      return {
        id: "container",
        available: false,
        compilers: [],
        buildSystems: [],
        missing,
        limitations,
      };
    }
    this.runtime = runtime;
    limitations.push(`Runtime is ${runtime.id}.`);

    if (!(await this.imagePresent(runtime, signal))) {
      missing.push({
        id: `image:${this.options.image}`,
        requiredFor: "building in a container",
      });
      limitations.push(
        `The image ${this.options.image} is not present locally, so it was not examined. uvp does not pull images: fetch it with ${runtime.id} yourself and re-run.`,
      );
      return {
        id: "container",
        ...(runtime.version === undefined ? {} : { version: runtime.version }),
        available: false,
        compilers: [],
        buildSystems: [],
        missing,
        limitations,
      };
    }

    const tools = await this.probeImage(runtime, signal);
    if (tools === undefined) {
      // The image is present and would not run. That is a fact about the image,
      // and it is reported as a limitation rather than as an absent compiler,
      // because "it has no compiler" is a claim this never established.
      missing.push({
        id: "image_runnable",
        requiredFor: `${runtime.id} run ${this.options.image}`,
      });
      limitations.push(
        `The image ${this.options.image} is present but did not run to completion, so its contents are unknown.`,
      );
      return {
        id: "container",
        ...(runtime.version === undefined ? {} : { version: runtime.version }),
        available: false,
        compilers: [],
        buildSystems: [],
        missing,
        limitations,
      };
    }

    const { compilers, buildSystems, missing: toolGaps } = describeTools(tools);
    missing.push(...toolGaps);

    // Said once, here, because every path above reports an in-image path and a
    // caller has no other way to know that.
    limitations.push(
      "Compiler and build-system paths are inside the image, not on this host, and cannot be executed here.",
    );
    limitations.push(
      "Builds write into the mounted workspace as this user; anything the container writes elsewhere is discarded when it exits.",
    );

    const cmake = buildSystems.find((system) => system.id === "cmake");
    return {
      id: "container",
      available: compilers.length > 0 && cmake !== undefined,
      ...(cmake?.version === undefined ? {} : { version: cmake.version }),
      compilers,
      buildSystems,
      missing,
      limitations,
    };
  }

  /**
   * The libuvcpp install inside the image.
   *
   * Throws rather than answering `found: false` when the image cannot be run,
   * and that is the port's own rule rather than a preference: `LibuvcppBuild`
   * has no way to say "not looked", and `found: false` is read by every caller
   * as "there is no libuvcpp here" — a claim about the image that nothing
   * observed. A provider that cannot run its toolchain at all is exactly the
   * case the port says is an error rather than a result.
   */
  async findLibuvcpp(
    workspacePath: string | undefined,
    signal: AbortSignal,
  ): Promise<LibuvcppBuild> {
    if (signal.aborted) throw cancelledFailure(DISCOVERY_CANCELLED);
    void workspacePath;

    const runtime = this.runtime ?? (await this.resolveRuntime(signal));
    if (runtime === undefined || !(await this.imagePresent(runtime, signal))) {
      throw new UvpFailure({
        code: "toolchain_unavailable",
        message: `The libuvcpp install inside ${this.options.image} could not be examined: the image is not present, or no container runtime is available.`,
        remediation: {
          action: `Make ${this.options.image} present locally, then re-run.`,
        },
      });
    }

    const prefixes = [
      ...(this.options.libuvcppPrefix === undefined ? [] : [this.options.libuvcppPrefix]),
      ...DEFAULT_IN_IMAGE_PREFIXES,
    ];
    // The layouts come from `libuvcppConfig`, joined with `/` because these are
    // in-image paths: the image is a Linux filesystem no matter what this host
    // is, and a host-separator join would produce paths no shell in it could open.
    const attempts = prefixes.flatMap((prefix) =>
      CONFIG_HEADER_RELATIVE_PATHS.map((segments) => ({
        prefix,
        // The directory, not just the file: `uvcpp_version.h` is generated and
        // installed beside the config header, so whatever layout answered is the
        // layout the version has to be read from. Asking for a second hardcoded
        // path would answer `version: undefined` for exactly the layouts the
        // search was widened to accept — a search that can find an install it
        // cannot then describe.
        directory: [prefix, ...segments.slice(0, -1)].join("/").replace(/\/+/gu, "/"),
        file: `${[prefix, ...segments].join("/")}`.replace(/\/+/gu, "/"),
      })),
    );
    const script = [
      ...attempts.map(
        ({ prefix, directory, file }) =>
          `if [ -f '${file}' ]; then printf 'PREFIX\\t%s\\t%s\\n' '${prefix}' '${directory}'; cat '${file}'; exit 0; fi`,
      ),
      "exit 1",
    ].join("\n");

    // The search runs in the image, so a prefix is the only thing it can find:
    // there is no `workspacePath` argument that means anything here, and the
    // workspace's own `third_party/libuvcpp` is visible only because the build
    // mounts it — not because this search could read it without a runtime.
    const outcome = await this.run({
      command: runtime.path,
      args: ["run", "--rm", "--entrypoint", "sh", this.options.image, "-c", script],
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
    });
    if (outcome.aborted) throw cancelledFailure(DISCOVERY_CANCELLED);

    const newline = outcome.stdout.indexOf("\n");
    if (outcome.exitCode !== 0 || newline < 0) {
      return {
        found: false,
        modules: [],
        note: `Searched ${prefixes.join(", ")} inside ${this.options.image}; no uvcpp_config.h was found there.`,
      };
    }

    const banner = outcome.stdout
      .slice(0, newline)
      .replace(/^PREFIX\t/u, "")
      .split("\t");
    const prefix = banner[0];
    const directory = banner[1];
    if (prefix === undefined || prefix === "" || directory === undefined || directory === "") {
      return {
        found: false,
        modules: [],
        note: `Searched ${prefixes.join(", ")} inside ${this.options.image}; no uvcpp_config.h was found there.`,
      };
    }

    const header = outcome.stdout.slice(newline + 1);
    const modules = modulesFromConfigHeader(header);
    const version = await this.versionInside(runtime, directory, signal);
    return {
      found: true,
      installPrefix: prefix,
      ...(version === undefined ? {} : { version, versionSource: "version_file" }),
      modules,
      note:
        modules.length === 0
          ? `Found ${prefix} inside ${this.options.image} but read no UVCPP_* module from its uvcpp_config.h.`
          : `Read from the image ${this.options.image}: paths are in-container, and ${prefix} must be visible to the build.`,
    };
  }

  /**
   * `uvcpp_version.h` from the directory the config header was found in.
   *
   * The directory rather than the prefix plus a fixed suffix, because the two
   * headers are generated and installed together: whichever layout answered is
   * the layout the version is in. A fixed `include/uvcpp/` here would report no
   * version for every install found through one of the other layouts, which
   * reads as "this install does not say" rather than "uvp looked in one place".
   */
  private async versionInside(
    runtime: ResolvedRuntime,
    directory: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const outcome = await this.run({
      command: runtime.path,
      args: [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        this.options.image,
        "-c",
        `cat "${directory}/uvcpp_version.h" 2>/dev/null || true`,
      ],
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
    });
    if (outcome.aborted) throw cancelledFailure(DISCOVERY_CANCELLED);
    return versionFromVersionHeader(outcome.stdout);
  }

  createClient(): ToolchainClient {
    return new ContainerToolchainClient(
      this.identity(),
      async (signal) => {
        // The cached one is returned as it is: the client checks the caller's
        // signal before it asks for a runtime at all, so a cached runtime can
        // only be reached by a call that has not been withdrawn.
        if (this.runtime !== undefined) return this.runtime;
        const resolved = await this.resolveRuntime(signal);
        if (resolved === undefined) {
          throw new UvpFailure({
            code: "toolchain_unavailable",
            message: "No container runtime is available, so nothing can be built in a container.",
            remediation: { action: "Install docker or podman, then re-run." },
          });
        }
        this.runtime = resolved;
        return resolved;
      },
      this.options,
      this.run,
    );
  }
}

class ContainerToolchainClient implements ToolchainClient {
  constructor(
    readonly identity: ToolchainIdentity,
    private readonly runtime: (signal: AbortSignal) => Promise<ResolvedRuntime>,
    private readonly options: ContainerProviderOptions,
    private readonly run: RunSlot,
  ) {}

  async build(request: BuildRequest): Promise<BuildOutcome> {
    // Before the runtime is looked for, and so before anything is started. The
    // port requires a call that arrived cancelled to establish nothing, and
    // without this line the resolver answers first with "no container runtime is
    // available" — a finding about this host, drawn from a search the caller had
    // already stopped, for a call that never began. It is also not what the
    // resolution means: with no runtime installed, a *live* call and a withdrawn
    // one would be told exactly the same thing, and the caller has no way to tell
    // "you pressed Ctrl-C" from "you have no docker".
    if (request.signal.aborted) throw cancelledFailure(BUILD_CANCELLED);
    const runtime = await this.runtime(request.signal);
    if (request.generator === "msbuild") {
      throw new UvpFailure({
        code: "unsupported_toolchain",
        message: "MSBuild is a Windows build system and cannot run inside a Linux container image.",
        remediation: { action: "Ask for the ninja or unix-makefiles generator instead." },
      });
    }

    const image = this.options.image;
    const runIn = async (cmakeArgs: readonly string[], env: Record<string, string>) =>
      await this.run({
        command: runtime.path,
        args: [
          "run",
          "--rm",
          // `--mount` rather than `-v` because it is the form that fails loudly
          // if the source does not exist, instead of silently creating an empty
          // directory where the workspace should have been.
          ...mountArgs([request.workspacePath, request.buildDir]),
          "--workdir",
          request.workspacePath,
          ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
          image,
          "cmake",
          ...cmakeArgs,
        ],
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      });

    const libuvcppPrefix = request.libuvcppPrefix ?? this.options.libuvcppPrefix;
    const env: Record<string, string> = {};
    if (libuvcppPrefix !== undefined) {
      // Built from nothing rather than extended from this process's environment:
      // the container's environment is the image's, and a host `CMAKE_PREFIX_PATH`
      // would name host directories that do not exist in there.
      env["CMAKE_PREFIX_PATH"] = libuvcppPrefix;
      env["PKG_CONFIG_PATH"] = `${libuvcppPrefix}/lib/pkgconfig:${libuvcppPrefix}/lib64/pkgconfig`;
    }

    const configureStart = Date.now();
    const configure = await runIn(
      [
        "-S",
        request.workspacePath,
        "-B",
        request.buildDir,
        `-DCMAKE_BUILD_TYPE=${request.buildType}`,
        ...generatorArgs(request.generator),
      ],
      env,
    );
    const configureDurationMs = Date.now() - configureStart;

    // Before the exit code, for the reason the port gives: a killed configure
    // exits non-zero and an outcome built from it claims the workspace does not
    // configure, which nothing here observed.
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
        // Read from the host, which works because the mount put the build
        // directory back where the caller named it.
        artifacts: succeeded ? await discoverArtifacts(request.buildDir) : [],
        commands,
      };
    }

    const buildArgs = ["--build", request.buildDir];
    if (request.jobs !== undefined) buildArgs.push("-j", String(request.jobs));
    if (request.target !== undefined) buildArgs.push("--target", request.target);
    if (request.clean) buildArgs.push("--clean-first");

    const compileStart = Date.now();
    const compile = await runIn(buildArgs, env);
    const compileDurationMs = Date.now() - compileStart;
    if (compile.aborted) throw cancelledFailure(BUILD_CANCELLED);
    commands.push(compile.command);
    diagnostics.push(...parseDiagnostics(compile.stdout, compile.stderr, "compile"));

    return {
      buildDir: request.buildDir,
      exitCode: compile.exitCode ?? -1,
      succeeded: compile.exitCode === 0,
      configureDurationMs,
      compileDurationMs,
      fromCache: compile.exitCode === 0 && noWorkWasDone(`${compile.stdout}\n${compile.stderr}`),
      diagnostics,
      artifacts: await discoverArtifacts(request.buildDir),
      commands,
    };
  }
}

/** One `--mount` per distinct path: a path mounted twice is an error in docker. */
const mountArgs = (paths: readonly string[]): readonly string[] =>
  [...new Set(paths)].flatMap((path) => ["--mount", `type=bind,source=${path},target=${path}`]);
