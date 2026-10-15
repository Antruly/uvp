import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BuildRequest } from "../../src/application/ToolchainProvider.js";
import { toUvpError } from "../../src/domain/errors.js";
import { ContainerToolchainProvider } from "../../src/toolchains/container/ContainerToolchainProvider.js";
import { describeProviderConformance, liveSignal } from "../conformance/providerContract.js";
import type { ProviderSubject } from "../conformance/providerContract.js";

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
 * ## What a run on this machine establishes, and what it does not
 *
 * This host has no container runtime. The obligations that need a toolchain —
 * the three about the shape of a libuvcpp search, and the four that run a build
 * — are therefore skipped **by name**, with the reason taken from the provider's
 * own report rather than assembled here. What still runs is the half that needs
 * nothing but the provider: an identity, a read-only inspection, the gap it names
 * when it cannot work, and the refusal to answer a call the caller withdrew.
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
 * **Nothing here establishes anything about docker, podman, or an image.** The
 * commands it would run have been read; they have not been observed running. See
 * `ContainerToolchainProvider.test.ts` for what a command line can be checked
 * against offline, and do not read a green run here as runtime evidence.
 *
 * ## Making this file exercise more
 *
 * Set `UVP_TEST_IMAGE` to an image reference that is *already present* on the
 * host and, with a runtime installed, the skipped obligations run. uvp never
 * pulls an image, and this file does not either: a lane that fetched its own
 * fixture would be testing a network as much as a toolchain, and would work on a
 * machine no user has.
 */

const IMAGE = process.env["UVP_TEST_IMAGE"] ?? "uvp-conformance-image:local";

const provider = new ContainerToolchainProvider({ image: IMAGE });

/**
 * The two gaps, in the provider's own words.
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

const substrateGap = availability.available
  ? ""
  : `the container toolchain reports itself unavailable (${gapWords()})`;

/**
 * Whether the provider can examine its own toolchain, established by asking it.
 *
 * Not inferred from `available`, which is a claim about compilers and CMake: an
 * image that runs but has neither is unavailable *and* perfectly searchable, and
 * gating the libuvcpp obligations on the wrong one would skip them on a machine
 * that could have answered them.
 */
const searchFailure = await provider.findLibuvcpp(undefined, liveSignal()).then(
  () => undefined,
  (cause: unknown) => toUvpError(cause),
);

const toolchainGap =
  searchFailure === undefined
    ? ""
    : `the provider cannot examine the libuvcpp inside ${IMAGE} (${searchFailure.message})`;

const requestFor = (signal: AbortSignal): BuildRequest => ({
  workspacePath: join(realpathSync(tmpdir()), "uvp-container-conformance", "nothing-here"),
  buildDir: join(realpathSync(tmpdir()), "uvp-container-conformance", "nothing-here", "build"),
  buildType: "Debug",
  clean: false,
  timeoutMs: 180_000,
  configureOnly: false,
  signal,
});

const subject: ProviderSubject = {
  name: `the container provider (${IMAGE})`,
  create: () => new ContainerToolchainProvider({ image: IMAGE }),
  request: requestFor,
  /**
   * Absent on purpose, even on a host where the four build obligations could
   * run, and this is the one piece of the file that is a judgement rather than a
   * reading.
   *
   * A substrate for `local` is a generated workspace and a real compile. For a
   * container it is the same thing *plus* a libuvcpp inside the image, at a path
   * inside the image, found by a search that has to work there — and this host
   * has no runtime, so none of that has been run even once. Writing it now would
   * be a fixture nobody has seen work, in a file whose entire purpose is to prove
   * that checks can fail. It goes in with the first run that can execute it.
   */
  substrate: undefined,
  substrateGap,
  toolchainGap,
};

describeProviderConformance(subject);
