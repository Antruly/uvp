import { mkdir } from "node:fs/promises";
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
import { UvpFailure, cancelledFailure } from "../../src/domain/errors.js";
import { sha256 } from "../../src/domain/identity.js";
import {
  installFakeExecutable,
  type FakeExecutable,
  type FakeProgram,
} from "../support/fakeExecutable.js";
import { FIXTURE_SCRIPT } from "./fixtureServer.js";

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
 *
 * It does establish one thing, and it is the reason `inspectAvailability`,
 * `findLibuvcpp`, and `build` below read the signal before they answer: a script
 * is as capable of honouring the provider contract as a compiler is, and
 * `providerContract.ts` runs the whole contract against this provider as its
 * control. A fake that answered a withdrawn call would make the contract's own
 * suite fail on its control, which is what a control is for.
 */

const NOWHERE = "/nonexistent/uvp-conformance-fixture";

/**
 * What each entry point says when the caller withdrew before it answered.
 *
 * Written out rather than shared with the local provider's constants, because a
 * fixture that quoted the real provider's wording would pass a test of that
 * wording for the wrong reason. The contract is that the failure is a
 * cancellation; the sentence is this fixture's own.
 */
const INSPECTION_CANCELLED =
  "The inspection was cancelled before it answered, so nothing was observed about this host.";
const DISCOVERY_CANCELLED =
  "The libuvcpp search was cancelled before it answered, so nothing was observed about this machine.";
const BUILD_CANCELLED =
  "The build was cancelled before it ran, so nothing was compiled and nothing was observed about the workspace.";

export interface FakeToolchainOptions {
  readonly id?: string;
  readonly version?: string;
  readonly available?: boolean;
  readonly compilers?: number;
  readonly buildSystems?: readonly string[];
  readonly missing?: readonly { id: string; requiredFor: string }[];
  readonly libuvcpp?: LibuvcppBuild;
  /**
   * Makes `findLibuvcpp` refuse, with this as the provider's sentence.
   *
   * The port says a provider that cannot run its toolchain at all refuses rather
   * than answering `found: false`, because every caller reads that as a claim
   * about the toolchain. A fixture that could only ever answer would leave the
   * other half of the port untestable at the boundary that has to handle it.
   */
  readonly libuvcppUnavailable?: string;
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
 * and spawns it. A program that starts a real listener is therefore enough to
 * exercise launch, readiness, and the whole verification workflow without a
 * toolchain — which is what lets this lane cover `uvp_run` and `uvp_verify` at
 * all. What is installed is a fake the *host* will start: `tests/support/`
 * owns that question, including the name this host gives it and the way the
 * program reaches it.
 *
 * The program is named by the caller rather than written here, because the port
 * it listens on is the caller's: it arrives as the program's first argument.
 * `installFakeExecutable` returns the arguments the launcher has to pass, and a
 * caller that drops them gets a Node with nothing to run — which is why the
 * result is spread into the tool call rather than used for its path alone.
 */
export const writeFakeBinary = async (
  workspacePath: string,
  name: string,
  program: FakeProgram,
): Promise<FakeExecutable> => {
  const buildDir = join(workspacePath, "build");
  await mkdir(buildDir, { recursive: true });
  return await installFakeExecutable(buildDir, name, program);
};

/** The fixture service, as a workspace's built binary on a given port. */
export const writeFakeService = async (
  workspacePath: string,
  name: string,
  port: number,
): Promise<FakeExecutable> =>
  await writeFakeBinary(workspacePath, name, {
    module: FIXTURE_SCRIPT,
    args: [String(port)],
  });

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
    build: async (request) => {
      // Before the build, not after it. A scripted provider has no child process
      // to kill, so "cancelled" here is about the contract rather than about
      // stopping work: a caller that arrives cancelled gets a cancellation, and
      // never a report about a workspace nothing looked at.
      if (request.signal.aborted) throw cancelledFailure(BUILD_CANCELLED);
      return await (options.build ?? succeededBuild)(request);
    },
  };

  return {
    identity: () => identity,
    inspectAvailability: async (signal) => {
      if (signal.aborted) throw cancelledFailure(INSPECTION_CANCELLED);
      return defaultAvailability(options);
    },
    findLibuvcpp: async (_workspacePath, signal) => {
      if (signal.aborted) throw cancelledFailure(DISCOVERY_CANCELLED);
      if (options.libuvcppUnavailable !== undefined) {
        throw new UvpFailure({
          code: "toolchain_unavailable",
          message: options.libuvcppUnavailable,
          remediation: { action: "Make the toolchain runnable, then re-run." },
        });
      }
      return (
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
        }
      );
    },
    createClient: () => client,
  };
};

/** A provider that finds no libuvcpp at all, for the not-found path. */
export const createProviderWithoutLibuvcpp = (): ToolchainProvider =>
  createFakeToolchain({
    libuvcpp: { found: false, modules: [], note: "no libuvcpp was found" },
  });
