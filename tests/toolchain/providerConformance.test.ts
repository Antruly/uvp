import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll } from "vitest";

import { LocalToolchainProvider } from "../../src/toolchains/local/LocalToolchainProvider.js";
import { describeProviderConformance, liveSignal } from "../conformance/providerContract.js";
import type { ProviderSubject } from "../conformance/providerContract.js";
import { createWorkspaceSubstrate } from "../conformance/workspaceSubstrate.js";
import { cleanup } from "../support/realLibuvcpp.js";

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
 * What the build obligations are made of lives in
 * `tests/conformance/workspaceSubstrate.ts`, shared with the container lane so
 * that "the substrate" is one thing rather than two copies of one thing.
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

// The prefix is named rather than left for the provider to discover: `uvp build`
// takes the same path, and this file has just looked the library up. The comment
// in `workspaceSubstrate.ts` says why that matters.
const { substrate, requestFor, prepare } = createWorkspaceSubstrate({
  provider,
  libuvcppPrefix: libuvcpp.installPrefix,
  templatePort: TEMPLATE_PORT,
  slowBuildPort: SLOW_BUILD_PORT,
  where: "on this host",
  gap: substrateGap,
});

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
  substrate,
  substrateGap,
  // Empty, and not because a libuvcpp is installed — there may be none. A local
  // provider searches this machine's filesystem, and that search answers whether
  // or not anything is there to find. `found: false` is a real answer here, and
  // the three obligations that read its shape are exactly the ones a bare host
  // can still exercise.
  toolchainGap: "",
};

beforeAll(async () => {
  await prepare();
});

afterAll(() => {
  cleanup();
});

describeProviderConformance(subject);
