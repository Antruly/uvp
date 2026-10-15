import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll } from "vitest";

import type { BuildOutcome, BuildRequest } from "../../src/application/ToolchainProvider.js";
import { LocalToolchainProvider } from "../../src/toolchains/local/LocalToolchainProvider.js";
import { describeProviderConformance, liveSignal } from "../conformance/providerContract.js";
import type { ProviderSubject, ProviderSubstrate } from "../conformance/providerContract.js";
import { cleanup, createWorkspace, scratch } from "../support/realLibuvcpp.js";

/**
 * The provider contract, run against the provider that actually compiles C++.
 *
 * `tests/conformance/providerConformance.test.ts` runs the same obligations
 * against a script, which establishes that the contract is written down and that
 * each clause can fail. It cannot establish that the contract is *satisfiable* by
 * the thing uvp ships: a script agrees with whatever it is told. This file is the
 * other end — the real `LocalToolchainProvider`, a real CMake, the libuvcpp
 * installed on this machine, and a generated workspace that has to compile — and
 * it is why the suite is a conformance suite rather than a unit test of the fake.
 *
 * ## What the substrate costs, and what its absence costs
 *
 * Four of the twelve obligations are about a build, and a build here means a
 * compiler, a CMake, and a libuvcpp. When this host has all three they run; when
 * it does not, they are skipped **by name**, with the reason in the test title —
 * which was observed, not assumed: with everything but Node off `PATH`, this file
 * reports eight passing and four skipped, each naming the host's own words. The
 * other eight need nothing but the provider: an identity, an inspection, a
 * libuvcpp search, and a cancellation are answerable anywhere, and skipping them
 * because the expensive half was unavailable would throw away coverage that costs
 * nothing.
 *
 * The gap is read from the provider rather than assembled here — `available` and
 * `found` are the owning boundary's own answers, and a second opinion about them
 * in this file is a second thing that can be wrong.
 */

/** Compiled into a generated workspace but never bound: nothing starts a service here. */
const TEMPLATE_PORT = 8123;
const SLOW_BUILD_PORT = 8124;

const provider = new LocalToolchainProvider();
const availability = await provider.inspectAvailability(liveSignal());
const libuvcpp = await provider.findLibuvcpp(undefined, liveSignal());

/**
 * Why a build cannot be run here, or empty when it can.
 *
 * Both answers come from the provider, in its own words, so that a skipped run
 * reports what the toolchain said rather than what this file guessed.
 */
const substrateGap = [
  availability.available
    ? ""
    : `the host reports itself unavailable (${availability.missing.map((gap) => gap.id).join(", ")})`,
  libuvcpp.found ? "" : "no libuvcpp was found, so a generated workspace cannot be built",
]
  .filter((reason) => reason !== "")
  .join("; ");

const requestFor = (root: string, buildDir: string, signal: AbortSignal): BuildRequest => ({
  workspacePath: root,
  buildDir,
  buildType: "Debug",
  clean: false,
  timeoutMs: 180_000,
  configureOnly: false,
  // Named rather than discovered, which is the path `uvp build` takes: the
  // caller looked the library up and says which one the workspace is to be
  // judged against. Leaving it out would send the closed loop through discovery
  // instead, and the discovery guard is already the subject of the pre-aborted
  // build check below.
  ...(libuvcpp.installPrefix === undefined ? {} : { libuvcppPrefix: libuvcpp.installPrefix }),
  signal,
});

/**
 * A CMake project that configures and then does not compile.
 *
 * Written by hand rather than by breaking a generated workspace: it needs no
 * libuvcpp at all, so the failure is exactly one thing — a source file the
 * compiler rejects — and the diagnostics the obligation reads come from the
 * compiler rather than from a missing package.
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

let slowWorkspace: { readonly root: string; readonly buildDir: string } | undefined;

/** The generated workspace whose build the successful obligations read. */
let generated: Promise<{ readonly root: string; readonly buildDir: string }> | undefined;

const helloHttp = async (): Promise<{ readonly root: string; readonly buildDir: string }> =>
  (generated ??= createWorkspace("hello-http", TEMPLATE_PORT));

let successful:
  | Promise<{
      readonly request: BuildRequest;
      readonly outcome: BuildOutcome;
    }>
  | undefined;

const substrate: ProviderSubstrate = {
  // Asked for once and kept: two obligations read two fields of one build, and a
  // real compile costs seconds. A second build here would buy nothing.
  successfulBuild: async () => {
    successful ??= (async () => {
      const workspace = await helloHttp();
      const request = requestFor(workspace.root, workspace.buildDir, liveSignal());
      const outcome = await provider.createClient().build(request);
      if (!outcome.succeeded) {
        throw new Error(
          `the generated hello-http workspace did not build: ${JSON.stringify(outcome.diagnostics).slice(0, 1_000)}`,
        );
      }
      return { request, outcome };
    })();
    return await successful;
  },
  // A workspace nothing has built yet, so the call is a real configure and
  // compile rather than a "nothing to do" that could finish before the abort
  // lands — a cache hit would make the mid-flight check pass by completing.
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

const subject: ProviderSubject = {
  name: "the local provider",
  create: () => new LocalToolchainProvider(),
  // A path nothing needs to exist at. Only the pre-abort obligation calls this,
  // and a call that starts nothing cannot be shown to have started nothing by
  // pointing at a workspace that was really there.
  request: (signal) =>
    requestFor(
      join(realpathSync(tmpdir()), "uvp-local-conformance", "nothing-here"),
      join(realpathSync(tmpdir()), "uvp-local-conformance", "nothing-here", "build"),
      signal,
    ),
  substrate: substrateGap === "" ? substrate : undefined,
  substrateGap,
  // Empty, and not because a libuvcpp is installed — there may be none. A local
  // provider searches this machine's filesystem, and that search answers whether
  // or not anything is there to find. `found: false` is a real answer here, and
  // the three obligations that read its shape are exactly the ones a bare host
  // can still exercise.
  toolchainGap: "",
};

beforeAll(async () => {
  // The slow build's workspace is generated here rather than inside the call the
  // suite times: generating one runs `uvp init`, and an abort that landed during
  // it would be testing the pre-abort path while looking like the mid-flight one.
  if (substrateGap !== "") return;
  slowWorkspace = await createWorkspace("hello-http", SLOW_BUILD_PORT);
});

afterAll(() => {
  cleanup();
});

describeProviderConformance(subject);
