import { describe, expect, it } from "vitest";

import type {
  BuildOutcome,
  BuildRequest,
  ToolchainProvider,
} from "../../src/application/ToolchainProvider.js";
import { toUvpError } from "../../src/domain/errors.js";
import type { UvpError } from "../../src/domain/errors.js";

/**
 * The provider contract, as checks a provider must pass to be a provider.
 *
 * `local/` is the only implementation, and one implementation is not a port: it
 * is a class that happens to be injected. The difference is testable, and this is
 * the test. Every capability uvp promises about *any* toolchain — a container, a
 * machine reached over SSH — is written here once, against
 * `ToolchainProvider` and nothing below it, and every subject is run through the
 * same obligations. Two providers that pass them are swappable; two that merely
 * both "work" are two code paths, and the second one is where the surprises are.
 *
 * ## Obligations are data
 *
 * Each check is a value rather than an `it`, and `describeProviderConformance`
 * turns the values into tests. That indirection is the point: a check that is
 * only ever run against a conforming subject is a check nobody has seen fail, and
 * "it passed" then means "the assertion was reachable", not "the obligation
 * holds". Because the checks are callable, `providerSubjects.ts` can hand them a
 * provider built to break exactly one of them and require that they notice — the
 * same proof the rest of this repository does by reverting a fix, kept as a
 * fixture instead of a note in a commit message.
 *
 * ## What the substrate is, and what a missing one costs
 *
 * Half of these obligations are about a *build*, and a build needs a compiler, a
 * CMake, and a libuvcpp. A subject that cannot supply one says so in
 * `substrateGap`, and the obligations that need it are skipped **by name**, with
 * that reason in the test title — never passed. The obligations that do not need
 * a substrate still run, because they need nothing: an identity, an inspection,
 * and a cancellation are answerable on any host, including one with no C++
 * compiler at all. That is deliberate. A lane that skipped everything because the
 * expensive half was unavailable would have thrown away the cheap half.
 *
 * ## What passing this does not establish
 *
 * Conformance is not correctness. A provider that passes every check below can
 * still report the wrong libuvcpp version, build the wrong directory, or answer a
 * request with the wrong bytes; these obligations are about the *shape* of what a
 * provider promises, which is the part a caller infers from the port rather than
 * reads in a result. Whether the C++ actually compiles is `toolchain`'s question,
 * and no fake can answer it.
 */

/** A build a subject can actually run, when its host has the substrate for one. */
export interface ProviderSubstrate {
  /**
   * A build that succeeds, asked for at most once.
   *
   * The request comes back with the outcome because two obligations are about the
   * relation between them — where the caller asked the build to go, and where the
   * provider says it went. A second successful build would cost another compile
   * for no additional fact, and a real one costs seconds.
   */
  readonly successfulBuild: () => Promise<{
    readonly request: BuildRequest;
    readonly outcome: BuildOutcome;
  }>;
  /** A call that outlives a short interrupt, so a mid-flight abort can be observed. */
  readonly startSlowBuild: (signal: AbortSignal) => Promise<unknown>;
  /** A call that ends with `succeeded: false` rather than by throwing. */
  readonly runFailingBuild: () => Promise<BuildOutcome>;
}

export interface ProviderSubject {
  /** What this subject is, for the test titles. */
  readonly name: string;
  /** A provider to check. Called once per obligation, so no state carries between them. */
  create(): ToolchainProvider;
  /**
   * The build call this subject's provider is asked to make.
   *
   * On the subject rather than on the substrate because the cancellation checks
   * need a request and must not need a compiler: an already-aborted signal has to
   * stop the call before anything is spawned, and a provider that only refuses
   * once it has a real workspace has not satisfied that.
   */
  request(signal: AbortSignal): BuildRequest;
  /** Absent when this host cannot run a build, with `substrateGap` saying why. */
  readonly substrate?: ProviderSubstrate | undefined;
  /** Why `substrate` is absent. Empty when it is present. */
  readonly substrateGap: string;
}

export interface ProviderObligation {
  /** Stable identifier, so a fault fixture can name the obligation it breaks. */
  readonly id: string;
  /** What the provider must do, as the test title. */
  readonly description: string;
  /** True when this check cannot run without `ProviderSubstrate`. */
  readonly needsSubstrate: boolean;
  /** Resolves when the provider conforms; throws when it does not. */
  check(subject: ProviderSubject): Promise<void>;
}

/** A signal nothing has aborted. */
export const liveSignal = (): AbortSignal => new AbortController().signal;

/** A signal that was already aborted when the call was made. */
export const withdrawnSignal = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

/** The substrate, as a value. A skipped obligation must never reach this. */
export const substrateOf = (subject: ProviderSubject): ProviderSubstrate => {
  const substrate = subject.substrate;
  if (substrate === undefined) {
    throw new Error(
      `${subject.name} has no substrate (${subject.substrateGap}), so this check should have been skipped rather than run.`,
    );
  }
  return substrate;
};

/**
 * The failure a call reported, or an error when it answered instead.
 *
 * The second branch is the obligation rather than a convenience around it: a call
 * that resolves has answered, and for a withdrawn call every possible answer is a
 * claim about the machine drawn from a run that observed nothing.
 */
const failureOf = async (call: () => Promise<unknown>, what: string): Promise<UvpError> => {
  try {
    await call();
  } catch (cause) {
    return toUvpError(cause);
  }
  throw new Error(
    `${what} answered after the caller had withdrawn, so the withdrawal was reported as a finding about the host.`,
  );
};

/**
 * Require a call to report a cancellation, in the shape the contract fixes.
 *
 * `retryable: false` and the word in the message are both checked on purpose.
 * The code alone cannot tell whether the provider used `cancelledFailure` or
 * assembled a failure of its own with the right code and the wrong remedy — a
 * caller reading "Re-run the call" about a *host* would go and look for a
 * compiler that is right there. The message is the only part of the failure a
 * person reads, so it is the only part that can carry this check.
 */
const expectCancelled = async (call: () => Promise<unknown>, what: string): Promise<void> => {
  const failure = await failureOf(call, what);
  expect(failure.code, `${what} reported ${failure.code} for a call the caller stopped`).toBe(
    "cancelled",
  );
  expect(failure.category).toBe("cancelled");
  expect(failure.retryable, "a withdrawal established nothing, so there is nothing to retry").toBe(
    false,
  );
  expect(failure.message).toContain("cancelled");
};

/** Wait, so a call under test can be interrupted while it is still running. */
const wait = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long the mid-flight check waits before it withdraws.
 *
 * Long enough that a real configure has started — cmake is spawned within tens of
 * milliseconds and takes seconds to finish — and short enough not to add a
 * noticeable cost to a lane. The check below does not *assume* the call was still
 * running at this point; it requires it, because an abort that arrives after a
 * call has already answered is the pre-abort check wearing the mid-flight one's
 * name, and it would pass for the wrong reason on every provider.
 */
const INTERRUPT_AFTER_MS = 300;

export const PROVIDER_OBLIGATIONS: readonly ProviderObligation[] = [
  {
    id: "identity-is-one-answer",
    description: "names one provider, in its availability and in the client it hands out",
    needsSubstrate: false,
    check: async (subject) => {
      const provider = subject.create();
      const identity = provider.identity();
      expect(identity.id, "a provider with no id cannot be named in a result").not.toBe("");
      expect(
        identity.platform,
        "a result has to say which platform it describes, or a finding cannot be reproduced anywhere else",
      ).not.toBe("");

      // The same identity on both sides of the port. A result that says which
      // toolchain built it is only evidence if the answer is the one a caller
      // gets from asking the provider directly.
      expect(provider.createClient().identity).toEqual(identity);

      const availability = await provider.inspectAvailability(liveSignal());
      expect(
        availability.id,
        "the availability names a different provider than identity() does, so a caller comparing the two is comparing two things",
      ).toBe(identity.id);
    },
  },
  {
    id: "inspection-has-no-side-effects",
    description: "answers the same question twice the same way, so asking it changes nothing",
    needsSubstrate: false,
    check: async (subject) => {
      const provider = subject.create();
      const first = await provider.inspectAvailability(liveSignal());
      const second = await provider.inspectAvailability(liveSignal());
      expect(second.id).toBe(first.id);
      // Two answers to one question. This is not a claim that the host is frozen
      // — it is a claim that *inspecting* it is not what changed it. A provider
      // that installs, pulls, or configures anything while reporting what it can
      // do has made the report depend on the order it was asked in.
      expect(
        second.available,
        "the second inspection disagreed with the first, so inspecting this host is not a read-only operation",
      ).toBe(first.available);
    },
  },
  {
    id: "an-unavailable-provider-names-what-is-missing",
    description: "counts the gaps that make it unavailable, and says what each one blocks",
    needsSubstrate: false,
    check: async (subject) => {
      const availability = await subject.create().inspectAvailability(liveSignal());
      for (const gap of availability.missing) {
        expect(gap.id, "a gap with no id names nothing to install").not.toBe("");
        expect(
          gap.requiredFor,
          `the gap "${gap.id}" does not say which capability it blocks, so a caller cannot tell whether it matters to them`,
        ).not.toBe("");
      }
      if (!availability.available) {
        // One direction only, and deliberately: a provider can be available and
        // still list gaps — a container has no host filesystem, an MSVC host has
        // no Ninja — because the port promises per-capability gaps rather than
        // all-or-nothing. The converse is not a promise: unavailable with an
        // empty list is a caller being told no, with nothing to do about it.
        expect(
          availability.missing.length,
          "reported itself unavailable and named nothing as missing, so there is nothing a caller can fix",
        ).toBeGreaterThan(0);
      }
    },
  },
  {
    id: "a-descriptor-carries-a-path",
    description: "names a path for every compiler and build system it reports finding",
    needsSubstrate: false,
    check: async (subject) => {
      const availability = await subject.create().inspectAvailability(liveSignal());
      for (const entry of [...availability.compilers, ...availability.buildSystems]) {
        expect(entry.id, "a descriptor with no id cannot be named in a result").not.toBe("");
        expect(
          entry.path,
          `the "${entry.id}" it reports finding has no path, so a caller who wants to use it has nothing to use`,
        ).not.toBe("");
      }
    },
  },
  {
    id: "a-missing-libuvcpp-claims-nothing-else",
    description: "reports found: false without a version, a prefix, or modules to go with it",
    needsSubstrate: false,
    check: async (subject) => {
      const found = await subject.create().findLibuvcpp(undefined, liveSignal());
      if (found.found) {
        // An implication, checked in whichever direction this host can. A host
        // with an install never exercises the half below, which is why
        // `providerSubjects.ts` builds a provider that answers `found: false`
        // *and* a version, and requires this check to reject it.
        expect(found.installPrefix, "reported finding a libuvcpp and named no prefix").not.toBe(
          undefined,
        );
        return;
      }
      expect(found.modules, "an install that was not found cannot have modules").toEqual([]);
      expect(
        found.version,
        "named a version of an install it did not find, which is a number invented rather than read",
      ).toBeUndefined();
      expect(found.installPrefix).toBeUndefined();
    },
  },
  {
    id: "a-version-says-where-it-was-read",
    description: "carries the source alongside a libuvcpp version, since two installs can disagree",
    needsSubstrate: false,
    check: async (subject) => {
      const found = await subject.create().findLibuvcpp(undefined, liveSignal());
      if (!found.found) return;
      expect(found.installPrefix, "reported finding a libuvcpp and named no prefix").not.toBe(
        undefined,
      );
      if (found.version === undefined) return;
      // A prefix can hold two installs — one built from source over an unpacked
      // archive — and then the number depends on which file was read. A version
      // with no source is a number a caller cannot check when it disagrees with
      // the one they expected.
      expect(
        found.versionSource,
        "reported a version without saying which file it was read from",
      ).not.toBe(undefined);
    },
  },
  {
    id: "a-module-is-a-symbol-a-requirement-can-name",
    description:
      "lists only UVCPP_ symbols as modules, since those are what a feature is matched against",
    needsSubstrate: false,
    check: async (subject) => {
      const found = await subject.create().findLibuvcpp(undefined, liveSignal());
      for (const module of found.modules) {
        expect(
          /^UVCPP_[A-Z0-9_]*$/u.test(module),
          `"${module}" is listed as a module, and no feature requirement can be matched against it`,
        ).toBe(true);
      }
    },
  },
  {
    id: "an-outcome-names-the-directory-it-was-given",
    description:
      "reports the build directory it was asked for, and a verdict its exit code agrees with",
    needsSubstrate: true,
    check: async (subject) => {
      const { request, outcome } = await substrateOf(subject).successfulBuild();
      expect(
        outcome.buildDir,
        "the outcome names a directory the caller did not ask for, so its artifacts point somewhere else",
      ).toBe(request.buildDir);
      // Two fields a caller can read to reach opposite conclusions. `succeeded`
      // is the summary, `exitCode` is the evidence, and a caller reading the
      // evidence must not find it contradicting the summary.
      expect(outcome.succeeded, "exit code disagreeing with its own verdict").toBe(
        outcome.exitCode === 0,
      );
      expect(
        outcome.commands.length,
        "a build that does not say what it ran cannot be re-read, and re-reading it is the whole use of a failed one",
      ).toBeGreaterThan(0);
    },
  },
  {
    id: "a-failed-build-is-an-outcome",
    description: "answers a build that did not succeed with diagnostics rather than throwing",
    needsSubstrate: true,
    check: async (subject) => {
      const outcome = await substrateOf(subject).runFailingBuild();
      expect(outcome.succeeded, "a build the substrate was set up to fail reported success").toBe(
        false,
      );
      expect(outcome.exitCode, "a failed build with the exit code of a successful one").not.toBe(0);
      expect(
        outcome.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
        "a build that failed carried no error diagnostic, so a caller is told something went wrong and not what",
      ).toBe(true);
      expect(
        outcome.commands.length,
        "a failed build that does not say what it ran cannot be re-read",
      ).toBeGreaterThan(0);
    },
  },
  {
    id: "an-artifact-is-described",
    description: "gives every artifact a path, a size, and a digest",
    needsSubstrate: true,
    check: async (subject) => {
      const { outcome } = await substrateOf(subject).successfulBuild();
      for (const artifact of outcome.artifacts) {
        expect(artifact.path, "an artifact with no path cannot be found again").not.toBe("");
        expect(
          Number.isInteger(artifact.bytes) && artifact.bytes >= 0,
          `the size of "${artifact.path}" is ${String(artifact.bytes)}, which is not a byte count`,
        ).toBe(true);
        expect(
          artifact.digest,
          `"${artifact.path}" has no digest, so two builds of it cannot be compared`,
        ).not.toBe("");
      }
    },
  },
  {
    id: "a-call-that-arrives-cancelled-starts-nothing",
    description: "rejects every entry point when the signal was already aborted",
    needsSubstrate: false,
    check: async (subject) => {
      const provider = subject.create();
      const signal = withdrawnSignal();
      await expectCancelled(() => provider.inspectAvailability(signal), "an inspection");
      await expectCancelled(() => provider.findLibuvcpp(undefined, signal), "a libuvcpp search");
      await expectCancelled(
        () => provider.createClient().build(subject.request(signal)),
        "a build that arrived cancelled",
      );
    },
  },
  {
    id: "a-call-the-caller-stopped-is-cancelled",
    description:
      "rejects with a cancellation when the abort lands during the work, not only before it",
    needsSubstrate: true,
    check: async (subject) => {
      const controller = new AbortController();
      // Started with a live signal, and only then interrupted: a provider that
      // rejects a call that *arrived* cancelled is the obligation above, so this
      // one has to abort after the call is under way or it is testing nothing new.
      const call = substrateOf(subject).startSlowBuild(controller.signal);
      // Claimed here rather than only where it is awaited, so the expected
      // rejection is never an unhandled one while the race below runs.
      void Promise.resolve(call).catch(() => undefined);

      const answered = await Promise.race([
        Promise.resolve(call).then(
          () => true,
          () => true,
        ),
        wait(INTERRUPT_AFTER_MS).then(() => false),
      ]);
      expect(
        answered,
        `the call answered within ${String(INTERRUPT_AFTER_MS)} ms, so nothing was interrupted and this check established nothing about a call already under way`,
      ).toBe(false);

      controller.abort();
      await expectCancelled(async () => await call, "a build interrupted while it was running");
    },
  },
];

/**
 * Run every obligation against one subject, as tests.
 *
 * `it.skipIf` rather than a conditional test body: a skipped Vitest test is
 * reported, and the reason is in the title where the runner prints it. An
 * obligation that quietly returned early would be indistinguishable from one that
 * passed, which is the failure mode this whole file is written against.
 */
export const describeProviderConformance = (subject: ProviderSubject): void => {
  describe(`${subject.name}: the provider contract`, () => {
    for (const obligation of PROVIDER_OBLIGATIONS) {
      const missing = obligation.needsSubstrate && subject.substrate === undefined;
      it.skipIf(missing)(
        missing
          ? `${obligation.description} — skipped: ${subject.substrateGap}`
          : obligation.description,
        async () => {
          await obligation.check(subject);
        },
      );
    }
  });
};

/** The obligation a fault fixture is expected to break, by id. */
export const obligationById = (id: string): ProviderObligation => {
  const obligation = PROVIDER_OBLIGATIONS.find((candidate) => candidate.id === id);
  if (obligation === undefined) throw new Error(`no obligation with id "${id}"`);
  return obligation;
};
