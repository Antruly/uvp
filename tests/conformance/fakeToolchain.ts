import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  BuildOutcome,
  BuildRequest,
  LibuvcppBuild,
  ToolchainAvailability,
  ToolchainClient,
  ToolchainIdentity,
  ToolchainProvider,
} from "../../src/application/ToolchainProvider.js";
import { sha256 } from "../../src/domain/identity.js";

/**
 * A toolchain that answers from a script instead of from a compiler.
 *
 * The conformance lane asks one question: does every handler's output satisfy
 * the contract it was called through? Answering it does not require a C++
 * compiler — it requires a build that *succeeded*, in the same shape a real one
 * produces. Reaching for the real toolchain here would make the answer depend on
 * the host, which is the opposite of what this lane is for; the `toolchain` lane
 * covers the real thing.
 *
 * The fixture is deliberately explicit about what it does *not* establish. It
 * reports a compiler it never ran and a digest of bytes it wrote itself, and the
 * results that pass through it are only as true as the canned answers.
 */

const NOWHERE = "/nonexistent/uvp-conformance-fixture";

export interface FakeToolchainOptions {
  readonly id?: string;
  readonly version?: string;
  readonly available?: boolean;
  readonly compilers?: number;
  readonly buildSystems?: readonly string[];
  readonly missing?: readonly { id: string; requiredFor: string }[];
  readonly libuvcpp?: LibuvcppBuild;
  /** Replaces the default build outcome, or writes real files as a side effect. */
  readonly build?: (request: BuildRequest) => Promise<BuildOutcome>;
}

const defaultAvailability = (options: FakeToolchainOptions): ToolchainAvailability => {
  const buildSystems = options.buildSystems ?? ["cmake", "ninja", "make"];
  return {
    id: options.id ?? "fake",
    available: options.available ?? true,
    ...(options.version === undefined ? {} : { version: options.version }),
    compilers: Array.from({ length: options.compilers ?? 1 }, (_unused, index) => ({
      id: index === 0 ? "g++" : `g++-${String(index)}`,
      path: `/usr/bin/g++${index === 0 ? "" : `-${String(index)}`}`,
      version: "13.2.0",
      target: "x86_64-linux-gnu",
    })),
    buildSystems: buildSystems.map((id) => ({ id, path: `/usr/bin/${id}`, version: "1.0.0" })),
    missing: [...(options.missing ?? [])],
    limitations: [],
  };
};

/** A build that succeeded without running anything, in the shape a real one has. */
export const succeededBuild = (request: BuildRequest): BuildOutcome => ({
  buildDir: request.buildDir,
  exitCode: 0,
  succeeded: true,
  configureDurationMs: 120,
  compileDurationMs: 340,
  fromCache: false,
  diagnostics: [],
  artifacts: [
    {
      path: join(request.buildDir, "fixture"),
      bytes: 4_096,
      digest: sha256("fixture binary"),
    },
  ],
  commands: ["cmake -S . -B build", "cmake --build build"],
});

/** A build that failed, carrying diagnostics rather than throwing. */
export const failedBuild = (request: BuildRequest): BuildOutcome => ({
  buildDir: request.buildDir,
  exitCode: 1,
  succeeded: false,
  configureDurationMs: 90,
  compileDurationMs: 10,
  fromCache: false,
  diagnostics: [
    {
      severity: "error",
      file: join(request.workspacePath, "src", "main.cpp"),
      line: 42,
      column: 7,
      message: "expected ';' before '}' token",
      phase: "compile",
    },
  ],
  artifacts: [],
  commands: ["cmake -S . -B build"],
});

/**
 * Write an executable `build/<name>` into a workspace.
 *
 * `uvp_run` resolves the binary as `<build_dir>/<manifest.binary ?? manifest.name>`
 * and spawns it. A shell script that starts a real listener is therefore enough
 * to exercise launch, readiness, and the whole verification workflow without a
 * toolchain — which is what lets this lane cover `uvp_run` and `uvp_verify` at
 * all. The script is written by this fixture and executed by the test host's own
 * shell, the same way a built artifact would be.
 */
export const writeFakeBinary = async (
  workspacePath: string,
  name: string,
  script: string,
): Promise<string> => {
  const buildDir = join(workspacePath, "build");
  await mkdir(buildDir, { recursive: true });
  const path = join(buildDir, name);
  await writeFile(path, script, { mode: 0o755 });
  return path;
};

export const createFakeToolchain = (options: FakeToolchainOptions = {}): ToolchainProvider => {
  const identity: ToolchainIdentity = {
    id: options.id ?? "fake",
    version: options.version ?? "1.0.0",
    platform: "linux-x64",
  };

  const client: ToolchainClient = {
    identity,
    // The outcome builders are synchronous because nothing in them awaits; the
    // client's contract is asynchronous because a real one does. Normalising in
    // one place keeps every fixture from having to remember which it is.
    build: async (request) => await (options.build ?? succeededBuild)(request),
  };

  return {
    identity: () => identity,
    inspectAvailability: async (signal) => {
      if (signal.aborted) throw new Error("aborted");
      return defaultAvailability(options);
    },
    findLibuvcpp: async () =>
      options.libuvcpp ?? {
        found: true,
        version: "1.7.0",
        versionSource: "pkgconfig",
        installPrefix: NOWHERE,
        modules: [
          "UVCPP_OPENSSL_ENABLE",
          "UVCPP_NGHTTP2_ENABLE",
          "UVCPP_HTTP3_ENABLE",
          "UVCPP_QUIC_ENABLE",
          "UVCPP_WEB_ENABLE",
          "UVCPP_WEBAPP_ENABLE",
          "UVCPP_DB_ENABLE",
        ],
      },
    createClient: () => client,
  };
};

/** A provider that finds no libuvcpp at all, for the not-found path. */
export const createProviderWithoutLibuvcpp = (): ToolchainProvider =>
  createFakeToolchain({
    libuvcpp: { found: false, modules: [], note: "no libuvcpp was found" },
  });
