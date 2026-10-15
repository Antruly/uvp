import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll } from "vitest";

import { toUvpError } from "../../src/domain/errors.js";
import { ContainerToolchainProvider } from "../../src/toolchains/container/ContainerToolchainProvider.js";
import { describeProviderConformance, liveSignal } from "../conformance/providerContract.js";
import type { ProviderSubject } from "../conformance/providerContract.js";
import { createWorkspaceSubstrate } from "../conformance/workspaceSubstrate.js";
import { cleanup } from "../support/realLibuvcpp.js";

/**
 * The provider contract, run against the provider whose toolchain is an image.
 *
 * `tests/toolchain/providerConformance.test.ts` runs the same obligations against
 * `local`, and until this file existed that was still one implementation: a class
 * that happens to be injected. The container is structurally different in the
 * ways the contract is *about* — its toolchain is not on this host, its identity
 * carries an image reference rather than a platform, and the two most common
 * states of the world are "no runtime" and "no image", neither of which `local`
 * has an analogue for. Running the obligations against it is what shows they are
 * a contract rather than a description of `local`.
 *
 * What the build obligations are made of lives in
 * `tests/conformance/workspaceSubstrate.ts`, shared with the `local` lane — which
 * is the point of a conformance suite put another way: two subjects whose
 * substrate is one file are being asked the same question, and two subjects whose
 * substrate is two files that happen to look alike are not.
 *
 * ## What the substrate costs, and what its absence costs
 *
 * Seven obligations need the toolchain, and here that means three things at once:
 * a runtime, an image that is present locally, and a libuvcpp *inside* that
 * image. When all three hold they run; otherwise they are skipped **by name**,
 * with the reasons taken from the provider's own report rather than assembled
 * here. The remaining five need nothing but the provider: an identity, a
 * read-only inspection, the gap it names when it cannot work, and the refusal to
 * answer a call the caller withdrew.
 *
 * That last one is not decoration. A build that arrived cancelled used to resolve
 * its runtime with a *fresh* signal and answer `toolchain_unavailable` — a
 * finding about this machine, drawn from a search the caller had already stopped,
 * for a build that never began. That is the shape this obligation exists to
 * catch, and until this file existed it had never been pointed at a provider that
 * could produce it, because `local` cannot fail that way.
 *
 * **What it does not catch, observed rather than assumed.** Removing the entry
 * check from the container client leaves this whole file green. On a fresh
 * provider the runtime lookup notices the withdrawn signal on its way past and
 * reports the same cancellation, so the obligation is satisfied by a provider
 * that would still start a container for a build that arrived stopped — the case
 * where the runtime has already been resolved and the withdrawal is the only
 * thing left that can stop it. That case is pinned in
 * `ContainerToolchainProvider.test.ts`, which warms the provider first because
 * the obligation cannot: `subject.create()` is called once per obligation *so
 * that* no state carries between them.
 *
 * ## Where the image comes from
 *
 * `UVP_TEST_IMAGE` names it, and it must be **already present** on the host. uvp
 * never pulls an image and neither does this file: a lane that fetched its own
 * fixture would be testing a network as much as a toolchain, and would pass on a
 * machine that happens to reach a registry while failing on one that does not.
 * `scripts/build-conformance-image.mjs` builds one from the libuvcpp install that
 * uvp's own discovery finds, and prints the command line to run this file with.
 */

const IMAGE = process.env["UVP_TEST_IMAGE"] ?? "uvp-conformance-image:local";

/** Compiled into a generated workspace but never bound: nothing starts a service here. */
const TEMPLATE_PORT = 8131;
const SLOW_BUILD_PORT = 8132;

const provider = new ContainerToolchainProvider({ image: IMAGE });

/**
 * The gaps, in the provider's own words.
 *
 * Read from the provider rather than assembled from a guess about this host,
 * because the reasons a container lane cannot run are the provider's to name —
 * a missing runtime and a missing image are different sentences, and both are
 * already written down in `missing` and `limitations`.
 */
const availability = await provider.inspectAvailability(liveSignal());

const gapWords = (): string =>
  availability.missing.length === 0
    ? "the provider reported no gap"
    : availability.missing.map((gap) => gap.id).join(", ");

/**
 * The libuvcpp search, kept in whichever of its two shapes it took.
 *
 * A provider that cannot run its image *throws* here rather than answering
 * `found: false`, because `LibuvcppBuild` has no way to say "not looked". This
 * file has to keep that distinction: an image that was searched and held no
 * libuvcpp is a different situation from one that was never searched, and only
 * the first of them may be reported as "there is no libuvcpp in it".
 */
const searched = await provider.findLibuvcpp(undefined, liveSignal()).then(
  (libuvcpp) => ({ libuvcpp }),
  (cause: unknown) => ({ failure: toUvpError(cause) }),
);

const install = "libuvcpp" in searched && searched.libuvcpp.found ? searched.libuvcpp : undefined;

const substrateGap = [
  availability.available
    ? ""
    : `the container toolchain reports itself unavailable (${gapWords()})`,
  "failure" in searched
    ? `the libuvcpp inside ${IMAGE} could not be examined (${searched.failure.message})`
    : install === undefined
      ? `no libuvcpp was found inside ${IMAGE}, so a generated workspace cannot be built there`
      : "",
]
  .filter((reason) => reason !== "")
  .join("; ");

const toolchainGap =
  "failure" in searched
    ? `the provider cannot examine the libuvcpp inside ${IMAGE} (${searched.failure.message})`
    : "";

const { substrate, requestFor, prepare } = createWorkspaceSubstrate({
  provider,
  // The prefix is an **in-image** path, and passing it is the whole point of the
  // search having run: it reaches the build as `CMAKE_PREFIX_PATH` and
  // `PKG_CONFIG_PATH` in the container's environment, which is what makes the
  // generated project's fallback discovery route work against a release archive
  // that ships no CMake package config. Left out, the build would depend on the
  // image having been built with those variables pre-set — which
  // `scripts/container/Containerfile` deliberately does not do.
  libuvcppPrefix: install?.installPrefix,
  templatePort: TEMPLATE_PORT,
  slowBuildPort: SLOW_BUILD_PORT,
  where: `inside ${IMAGE}`,
  gap: substrateGap,
});

const subject: ProviderSubject = {
  name: `the container provider (${IMAGE})`,
  create: () => new ContainerToolchainProvider({ image: IMAGE }),
  // A path nothing needs to exist at. Only the pre-abort obligation calls this,
  // and a call that starts nothing cannot be shown to have started nothing by
  // pointing at a workspace that was really there.
  request: (signal) =>
    requestFor(
      join(realpathSync(tmpdir()), "uvp-container-conformance", "nothing-here"),
      join(realpathSync(tmpdir()), "uvp-container-conformance", "nothing-here", "build"),
      signal,
    ),
  substrate,
  substrateGap,
  toolchainGap,
};

beforeAll(async () => {
  await prepare();
});

afterAll(() => {
  cleanup();
});

describeProviderConformance(subject);
