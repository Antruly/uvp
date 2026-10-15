import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  BuildOutcome,
  BuildRequest,
  ToolchainProvider,
} from "../../src/application/ToolchainProvider.js";
import type { Workspace } from "../support/realLibuvcpp.js";
import { createWorkspace, scratch } from "../support/realLibuvcpp.js";
import { liveSignal } from "./providerContract.js";
import type { ProviderSubstrate } from "./providerContract.js";

/**
 * The substrate the build obligations run on, for a provider that really builds.
 *
 * Four of the twelve obligations in `providerContract.ts` need a build: one asks
 * for one, one times one, one interrupts one, and one reads an artifact out of
 * one. Supplying that is the same work for every real provider — generate a
 * workspace, build it, fail a hand-written one, generate a second workspace that
 * nothing has built yet — and it differs only in which provider does the
 * building and where "there" is.
 *
 * Two files had written it out separately, and `jscpd` said so in as many words:
 * 34 lines and 145 tokens, identical down to the comments, in
 * `toolchain/providerConformance` and `toolchain/containerConformance`. That is
 * the shape of duplication this repository treats as a defect rather than as a
 * coincidence — not because the lines are long, but because a correction to the
 * substrate in one of them is a correction the other does not get, and the two
 * drift into being two subjects that merely look alike. The container lane is
 * where the third of those obligations was first failed for a real reason, which
 * is exactly the moment the copy in the other file became a liability.
 *
 * What stays with each caller is what is genuinely about that provider: where its
 * libuvcpp came from and what that path means, how its absence is worded, and
 * which prefix its requests carry. Those are the parts that differ, and they are
 * the parts worth reading side by side.
 */

export interface WorkspaceSubstrateOptions {
  /** The provider every build goes through. Its client is asked for per build. */
  readonly provider: ToolchainProvider;
  /**
   * The libuvcpp install the builds are to be judged against, or `undefined` to
   * let the provider find one for itself.
   *
   * Named rather than discovered, which is the path `uvp build` takes: the caller
   * looked the library up and says which one the workspace is to be judged
   * against. Leaving it out would send every build through discovery instead, and
   * the discovery guard is already the subject of the pre-aborted build check.
   */
  readonly libuvcppPrefix: string | undefined;
  /** The ports the two generated workspaces are compiled with. Nothing binds them. */
  readonly templatePort: number;
  readonly slowBuildPort: number;
  /** Where the build happens, for the one message that has to say so. */
  readonly where: string;
  /**
   * Why no build can be run here, in the provider's own words. Empty when one can.
   *
   * Passed in rather than worked out here, because the reasons a provider cannot
   * build are the provider's to name — `available` and its `missing` list,
   * `found`, and the two shapes `findLibuvcpp` can take. A second opinion
   * assembled inside this file would be a second thing that can be wrong, and it
   * would be wrong in the direction that matters: reporting the host's health as
   * a fact about uvp, or claiming a build that never ran.
   */
  readonly gap: string;
}

export interface WorkspaceSubstrateRun {
  /** The substrate to hand the suite, or `undefined` when `gap` says there is none. */
  readonly substrate: ProviderSubstrate | undefined;
  /**
   * The request shape every build in the suite is made with.
   *
   * Exposed because one obligation — the pre-aborted one — needs a request for a
   * workspace that does not exist, and it must be a request of the same shape as
   * the others: a different shape there would be testing a different code path.
   */
  requestFor(root: string, buildDir: string, signal: AbortSignal): BuildRequest;
  /**
   * Generate the slow build's workspace. Call from the caller's `beforeAll`; a
   * no-op when there is no substrate.
   *
   * Outside the call the suite times, because generating one runs `uvp init`, and
   * an abort that landed during *that* would be testing the pre-abort path while
   * looking like the mid-flight one.
   */
  prepare(): Promise<void>;
}

/** The template every generated workspace here is built from. */
const TEMPLATE = "hello-http";

/**
 * A CMake project that configures and then does not compile.
 *
 * Written by hand rather than by breaking a generated workspace: it needs no
 * libuvcpp at all, so the failure is exactly one thing — a source file the
 * compiler rejects — and the diagnostics the obligation reads come from the
 * compiler rather than from a missing package. A generated workspace could not
 * make that guarantee, because it links a library, and "the compiler rejected
 * this" and "the library was not there" arrive as the same kind of outcome.
 */
const writeBrokenWorkspace = (): { readonly root: string; readonly buildDir: string } => {
  const root = join(scratch(), "does-not-compile");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "CMakeLists.txt"),
    [
      "cmake_minimum_required(VERSION 3.16)",
      "project(provider-conformance CXX)",
      "add_executable(conformance src/main.cpp)",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "src", "main.cpp"), "int main() { return undefined_symbol_here(); }\n");
  return { root, buildDir: join(root, "build") };
};

export const createWorkspaceSubstrate = (
  options: WorkspaceSubstrateOptions,
): WorkspaceSubstrateRun => {
  const { provider, libuvcppPrefix, templatePort, slowBuildPort, where, gap } = options;

  const requestFor = (root: string, buildDir: string, signal: AbortSignal): BuildRequest => ({
    workspacePath: root,
    buildDir,
    buildType: "Debug",
    clean: false,
    timeoutMs: 180_000,
    configureOnly: false,
    ...(libuvcppPrefix === undefined ? {} : { libuvcppPrefix }),
    signal,
  });

  let slowWorkspace: Workspace | undefined;

  /** The generated workspace whose build the successful obligations read. */
  let generated: Promise<Workspace> | undefined;

  const helloHttp = async (): Promise<Workspace> =>
    (generated ??= createWorkspace(TEMPLATE, templatePort));

  let successful:
    | Promise<{
        readonly request: BuildRequest;
        readonly outcome: BuildOutcome;
      }>
    | undefined;

  const substrate: ProviderSubstrate = {
    // Asked for once and kept: two obligations read two fields of one build, and
    // a real compile costs seconds — more where the compile is a container start
    // on top of it. A second build here would buy nothing.
    successfulBuild: async () => {
      successful ??= (async () => {
        const workspace = await helloHttp();
        const request = requestFor(workspace.root, workspace.buildDir, liveSignal());
        const outcome = await provider.createClient().build(request);
        if (!outcome.succeeded) {
          throw new Error(
            `the generated ${TEMPLATE} workspace did not build ${where}: ${JSON.stringify(outcome.diagnostics).slice(0, 1_000)}`,
          );
        }
        return { request, outcome };
      })();
      return await successful;
    },
    // A workspace nothing has built yet, so the call is a real configure and
    // compile rather than a "nothing to do" that could finish before the abort
    // lands — a cache hit would make the mid-flight check pass by completing. The
    // build directory is deliberately **not** created here, for the same reason:
    // it is the state `uvp build` leaves a workspace in, and creating it would be
    // this helper arranging for a precondition the provider is supposed to meet
    // itself. That is not a hypothetical — it is the precondition `local` met by
    // accident, because `cmake -B` creates the directory, and that the container
    // provider, which bind-mounts it, had to be corrected to meet.
    startSlowBuild: async (signal) => {
      const workspace = slowWorkspace;
      if (workspace === undefined) {
        throw new Error(
          "the slow build's workspace was never generated, though the substrate exists",
        );
      }
      return await provider
        .createClient()
        .build(requestFor(workspace.root, workspace.buildDir, signal));
    },
    runFailingBuild: async () => {
      const broken = writeBrokenWorkspace();
      return await provider
        .createClient()
        .build(requestFor(broken.root, broken.buildDir, liveSignal()));
    },
  };

  return {
    substrate: gap === "" ? substrate : undefined,
    requestFor,
    prepare: async () => {
      if (gap !== "") return;
      slowWorkspace = await createWorkspace(TEMPLATE, slowBuildPort);
    },
  };
};
