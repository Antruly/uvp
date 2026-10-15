import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BuildOutcome,
  BuildRequest,
  ToolchainProvider,
} from "../../src/application/ToolchainProvider.js";
import { cancelledFailure } from "../../src/domain/errors.js";
import { createFakeToolchain, failedBuild, succeededBuild } from "./fakeToolchain.js";
import type { FakeToolchainOptions } from "./fakeToolchain.js";
import { liveSignal, obligationById } from "./providerContract.js";
import type { ProviderObligation, ProviderSubject, ProviderSubstrate } from "./providerContract.js";

/**
 * Subjects for the provider contract: one that conforms, and one per way of
 * failing it.
 *
 * The conforming subject is the suite's control — it is what makes a passing run
 * mean "these checks are reachable and the provider satisfies them" rather than
 * "these checks never ran". The rest exist because of the other half of that
 * sentence: a check nobody has seen fail is a check nobody can trust, and the
 * only way to show one fails is to hand it a provider that breaks it.
 *
 * Each fault below breaks **exactly one** obligation, and the meta-test in
 * `providerContractFaults.test.ts` requires both halves of that: that the named
 * obligation rejects this subject, and that every other obligation accepts it. A
 * fault that tripped two checks would leave it ambiguous which one was doing the
 * work, and a suite can accumulate a lot of that ambiguity before anyone
 * notices.
 *
 * ## These are scripts, and say only what scripts can
 *
 * Every subject here is built on `fakeToolchain.ts`, so nothing below establishes
 * anything about a real compiler — it establishes that the contract is written
 * down precisely enough to be violated one clause at a time. The real provider is
 * the subject of `tests/toolchain/providerConformance.test.ts`, and the two runs
 * are not interchangeable.
 */

/**
 * A path no call in this file needs to exist.
 *
 * Deliberately not a directory this file creates: the cancellation obligation is
 * that a withdrawn call starts nothing, and a check for it that pointed at a real
 * workspace could pass because the provider was slow rather than because it
 * stopped. The scripted provider never opens the path at all, so a path that
 * exists would only make the fixture look more real than it is.
 */
const NOWHERE = join(realpathSync(tmpdir()), "uvp-provider-contract", "nothing-here");

const requestAt = (signal: AbortSignal, buildDir: string): BuildRequest => ({
  workspacePath: NOWHERE,
  buildDir,
  buildType: "Debug",
  clean: false,
  timeoutMs: 60_000,
  configureOnly: false,
  signal,
});

/** Resolve when the caller withdraws. Never resolves on a signal nobody aborts. */
const untilWithdrawn = async (signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => {
      resolve();
    });
  });
};

export interface FakeSubjectOptions {
  readonly name?: string;
  /** What the scripted provider reports about the host. */
  readonly toolchain?: FakeToolchainOptions;
  /** The build the substrate reports as the successful one. */
  readonly succeed?: (request: BuildRequest) => Promise<BuildOutcome>;
  /** The build the substrate reports as the failed one. */
  readonly fail?: (request: BuildRequest) => Promise<BuildOutcome>;
  /** Wraps the conforming provider. One fault per option, below. */
  readonly provider?: (base: ToolchainProvider) => ToolchainProvider;
  /** Wraps the conforming substrate. */
  readonly substrate?: (base: ProviderSubstrate) => ProviderSubstrate;
}

export const fakeSubject = (options: FakeSubjectOptions = {}): ProviderSubject => {
  const toolchain = createFakeToolchain(options.toolchain);
  const succeed = options.succeed ?? (async (request: BuildRequest) => succeededBuild(request));
  const fail = options.fail ?? (async (request: BuildRequest) => failedBuild(request));

  // Asked for once and kept, because the two obligations that read it are about
  // two different fields of one build, and a second one would be a second
  // fixture. A real subject memoises for a stronger reason: a compile costs
  // seconds, and running one twice to learn one more field about it is a cost
  // with nothing bought.
  let successful:
    | Promise<{ readonly request: BuildRequest; readonly outcome: BuildOutcome }>
    | undefined;

  const base: ProviderSubstrate = {
    successfulBuild: async () => {
      successful ??= (async () => {
        const request = requestAt(liveSignal(), join(NOWHERE, "build"));
        return { request, outcome: await succeed(request) };
      })();
      return await successful;
    },
    startSlowBuild: async (signal) => {
      // A build that is still running when the abort lands, and stays running
      // until it does. Waiting on the signal rather than on a timer is what makes
      // this deterministic: two clocks racing is how a cancellation test becomes
      // a test of how loaded the machine was.
      await untilWithdrawn(signal);
      throw cancelledFailure(
        "The build was cancelled while it was running, so nothing was compiled and nothing was observed about the workspace.",
      );
    },
    runFailingBuild: async () => await fail(requestAt(liveSignal(), join(NOWHERE, "broken-build"))),
  };

  const prov = toolchain;
  return {
    name: options.name ?? "the scripted provider",
    create: () => (options.provider === undefined ? prov : options.provider(prov)),
    request: (signal) => requestAt(signal, join(NOWHERE, "build")),
    substrate: options.substrate === undefined ? base : options.substrate(base),
    substrateGap: "",
  };
};

/** One way of failing the contract, and the subject that fails it. */
export interface ProviderFault {
  readonly obligation: ProviderObligation;
  readonly subject: ProviderSubject;
}

export const PROVIDER_FAULTS: readonly ProviderFault[] = [
  {
    // The provider says one name and its availability says another. A caller
    // comparing the two — which is how a result is attributed to a toolchain —
    // is comparing two different things.
    obligation: obligationById("identity-is-one-answer"),
    subject: fakeSubject({
      name: "a provider whose availability names somebody else",
      provider: (base) => ({
        ...base,
        inspectAvailability: async (signal) => ({
          ...(await base.inspectAvailability(signal)),
          id: "somebody-else",
        }),
      }),
    }),
  },
  {
    // The second inspection disagrees with the first, so inspecting the host is
    // not a read: a provider that pulls an image or installs a package while
    // reporting what it can do has made the report depend on when it was asked.
    obligation: obligationById("inspection-has-no-side-effects"),
    subject: fakeSubject({
      name: "a provider that changes what it reports by being asked twice",
      provider: (base) => {
        let asked = 0;
        return {
          ...base,
          inspectAvailability: async (signal) => {
            const availability = await base.inspectAvailability(signal);
            asked += 1;
            return asked === 1
              ? availability
              : { ...availability, available: !availability.available };
          },
        };
      },
    }),
  },
  {
    // Unavailable with an empty list. The caller is told no and given nothing to
    // do about it, which is where a person starts guessing.
    obligation: obligationById("an-unavailable-provider-names-what-is-missing"),
    subject: fakeSubject({
      name: "a provider that is unavailable and names nothing as missing",
      provider: (base) => ({
        ...base,
        inspectAvailability: async (signal) => ({
          ...(await base.inspectAvailability(signal)),
          available: false,
          missing: [],
        }),
      }),
    }),
  },
  {
    // A gap that names what is absent and not what it costs. "compiler" alone
    // does not tell a caller whether the capability they wanted is affected.
    obligation: obligationById("an-unavailable-provider-names-what-is-missing"),
    subject: fakeSubject({
      name: "a provider whose gaps do not say what they block",
      provider: (base) => ({
        ...base,
        inspectAvailability: async (signal) => ({
          ...(await base.inspectAvailability(signal)),
          missing: [{ id: "compiler", requiredFor: "" }],
        }),
      }),
    }),
  },
  {
    // A compiler it reports finding, with nowhere to find it. The descriptor
    // promises something the path does not support.
    obligation: obligationById("a-descriptor-carries-a-path"),
    subject: fakeSubject({
      name: "a provider that lists a compiler with no path",
      provider: (base) => ({
        ...base,
        inspectAvailability: async (signal) => {
          const availability = await base.inspectAvailability(signal);
          return {
            ...availability,
            compilers: availability.compilers.map((entry) => ({ ...entry, path: "" })),
          };
        },
      }),
    }),
  },
  {
    // `found: false` is a claim that there is nothing here. A version on the
    // same answer is a number that was invented, and a caller who reads it will
    // check their installation against it.
    obligation: obligationById("a-missing-libuvcpp-claims-nothing-else"),
    subject: fakeSubject({
      name: "a provider that did not find a libuvcpp and named its version",
      toolchain: {
        libuvcpp: { found: false, version: "1.7.0", versionSource: "pkgconfig", modules: [] },
      },
    }),
  },
  {
    obligation: obligationById("a-missing-libuvcpp-claims-nothing-else"),
    subject: fakeSubject({
      name: "a provider that did not find a libuvcpp and listed its modules",
      toolchain: { libuvcpp: { found: false, modules: ["UVCPP_WEB_ENABLE"] } },
    }),
  },
  {
    // The number without the file it came from. Two installs under one prefix
    // answer differently, and the caller has no way to see which answered.
    obligation: obligationById("a-version-says-where-it-was-read"),
    subject: fakeSubject({
      name: "a provider that reports a version without its source",
      toolchain: {
        libuvcpp: { found: true, version: "1.7.0", installPrefix: NOWHERE, modules: [] },
      },
    }),
  },
  {
    // A module no requirement can be matched against. It reads as a capability
    // in a report and is not one anywhere in the code.
    obligation: obligationById("a-module-is-a-symbol-a-requirement-can-name"),
    subject: fakeSubject({
      name: "a provider that lists something that is not a UVCPP_ symbol",
      toolchain: {
        libuvcpp: { found: true, installPrefix: NOWHERE, modules: ["HTTP_ENABLE"] },
      },
    }),
  },
  {
    // The build went where the provider decided, not where it was told. Every
    // artifact path is then relative to a directory the caller never named.
    obligation: obligationById("an-outcome-names-the-directory-it-was-given"),
    subject: fakeSubject({
      name: "a provider whose outcome names another build directory",
      succeed: async (request) => ({
        ...succeededBuild(request),
        buildDir: join(NOWHERE, "elsewhere"),
      }),
    }),
  },
  {
    // The verdict and the evidence disagree. A caller reading `succeeded` and a
    // caller reading `exitCode` reach opposite conclusions about one build.
    obligation: obligationById("an-outcome-names-the-directory-it-was-given"),
    subject: fakeSubject({
      name: "a provider whose verdict disagrees with its own exit code",
      succeed: async (request) => ({ ...succeededBuild(request), succeeded: false }),
    }),
  },
  {
    // A failure reported as a throw. The port fixes a failed build as an outcome
    // carrying diagnostics, because a caller that gets an exception has nowhere
    // to read the compiler's words.
    obligation: obligationById("a-failed-build-is-an-outcome"),
    subject: fakeSubject({
      name: "a provider that throws instead of reporting a failed build",
      substrate: (base) => ({
        ...base,
        runFailingBuild: async () => {
          throw new Error("the compile failed");
        },
      }),
    }),
  },
  {
    // An artifact with no digest is an artifact two builds cannot be compared
    // through, which is most of what an artifact listing is for.
    obligation: obligationById("an-artifact-is-described"),
    subject: fakeSubject({
      name: "a provider whose artifact has no digest",
      succeed: async (request) => ({
        ...succeededBuild(request),
        artifacts: [{ path: join(request.buildDir, "fixture"), bytes: 4_096, digest: "" }],
      }),
    }),
  },
  {
    // The pre-abort half of the cancellation clause, ignored: the provider
    // reports what it collected from a run the caller had already stopped.
    obligation: obligationById("a-call-that-arrives-cancelled-starts-nothing"),
    subject: fakeSubject({
      name: "a provider that answers a withdrawn inspection",
      provider: (base) => ({
        ...base,
        inspectAvailability: async () => await base.inspectAvailability(liveSignal()),
      }),
    }),
  },
  {
    // The other way to fail the same obligation: nothing is interrupted because
    // there is nothing left running to interrupt. Not a provider being dishonest
    // — a provider whose build was a cache hit, which is why the check refuses to
    // score the abort as proof when the call had already answered.
    obligation: obligationById("a-call-the-caller-stopped-is-cancelled"),
    subject: fakeSubject({
      name: "a provider whose slow build finishes before it can be interrupted",
      substrate: (base) => ({
        ...base,
        startSlowBuild: async () => succeededBuild(requestAt(liveSignal(), join(NOWHERE, "build"))),
      }),
    }),
  },
  {
    // The mid-flight half, ignored: the call finishes and answers after the
    // caller stopped waiting for it.
    obligation: obligationById("a-call-the-caller-stopped-is-cancelled"),
    subject: fakeSubject({
      name: "a provider that answers a build the caller interrupted",
      substrate: (base) => ({
        ...base,
        startSlowBuild: async (signal) => {
          await untilWithdrawn(signal);
          return succeededBuild(requestAt(liveSignal(), join(NOWHERE, "build")));
        },
      }),
    }),
  },
];
