import { bundleDigest } from "./VerificationService.js";
import type { VerificationStatus, VerifyResult } from "./VerificationService.js";

/**
 * Comparing two verification passes.
 *
 * The unit is what `uvp_verify` returned, because that is the only artifact in
 * the system carrying a `bundle_digest` — and the digest is over a *projection*
 * of a pass: the status, each exchange's name, status and assertion counts in
 * order, and the unanswered questions in order. A comparison built on anything
 * else would be answering a different question from the one the digest answers,
 * and the two would eventually disagree in public.
 *
 * Five ways to report a difference that is not a change in the world, each of
 * which a rule below is written against:
 *
 * - **The clock and the identifiers are not compared.** `bundle_id` and
 *   `exchange_id` are minted per pass, `elapsed_ms` is a stopwatch reading, and
 *   `service.endpoint` names whichever port the caller happened to pick. Two
 *   passes that established exactly the same things differ in all four, so they
 *   are reported and never judged.
 * - **The digest sees the verdict, not the evidence.** `assertions_failed` is in
 *   it; the failure *text* is not. Two passes can therefore share a digest while
 *   the sentence explaining the failure changed, so `changed_fields` says what
 *   differs and `verdict_changed` says whether the digest can see it.
 * - **The digest is order-sensitive, so this is too.** Exchange names are hashed
 *   in the order they were asked. Ignoring order here would produce a report
 *   reading `identical` beside two different digests, so `order_changed` names
 *   the reordering instead of leaving it to be discovered by comparing digests.
 * - **A digest that does not describe its own contents grounds nothing.** The
 *   supplied `bundle_digest` is recomputed from the fields actually present. If
 *   the two disagree, the bundle is self-inconsistent — edited, truncated, or
 *   assembled by hand — and equality between two such digests would be a
 *   coincidence rather than a finding.
 * - **Two passes over different workspaces are two subjects, not two moments.**
 *   A workspace id is derived from the resolved path, so it survives the session
 *   that minted it, and a difference between two of them is not a change.
 */

/** A verification pass, as `uvp_verify` reports one. */
export type ComparedBundle = Pick<
  VerifyResult,
  | "goal"
  | "workspace_id"
  | "bundle_id"
  | "bundle_digest"
  | "status"
  | "build"
  | "service"
  | "exchanges"
  | "unverified"
>;

type Exchange = ComparedBundle["exchanges"][number];

/** The fields of an exchange this comparison reads. */
export type ExchangeField = "status" | "assertions_passed" | "assertions_failed" | "failures";

/** Same number, different field: named once so the table below stays readable. */
const differsFrom =
  <T, U>(read: (value: T) => U) =>
  (a: T, b: T): boolean =>
    read(a) !== read(b);

/**
 * Compared as a whole list, because a failure is a sentence: two passes whose
 * failure lists hold the same sentences in a different order have said the same
 * thing, and one that dropped a sentence has not.
 */
const failuresDiffer = (a: Exchange, b: Exchange): boolean =>
  JSON.stringify(a.failures) !== JSON.stringify(b.failures);

interface FieldRule {
  readonly field: ExchangeField;
  /** Whether the two values differ as the report states them. */
  readonly differs: (a: Exchange, b: Exchange) => boolean;
  /**
   * Whether they differ as `bundleDigest` reads them, or null when the digest
   * does not read this field at all.
   */
  readonly digestDiffers: ((a: Exchange, b: Exchange) => boolean) | null;
}

/**
 * Every field of an exchange this comparison reads, with the two questions kept
 * apart: what the record says, and what the digest can see.
 *
 * They are one table because they are one field list. Split into two lists, the
 * digest's coverage would be a fact maintained by hand beside the comparison
 * that depends on it, and `same_digest: true` next to `outcome: changed` would
 * read as a bug rather than as the specific thing it is.
 */
const FIELDS: readonly FieldRule[] = [
  {
    field: "status",
    differs: differsFrom((entry: Exchange) => entry.status),
    // `bundleDigest` maps a missing status to 0, so "no response at all" and
    // "status 0" are the same finding to it — which is why the two comparisons
    // are not the same comparison.
    digestDiffers: (a, b) => (a.status ?? 0) !== (b.status ?? 0),
  },
  {
    field: "assertions_passed",
    differs: differsFrom((entry: Exchange) => entry.assertions_passed),
    digestDiffers: differsFrom((entry: Exchange) => entry.assertions_passed),
  },
  {
    field: "assertions_failed",
    differs: differsFrom((entry: Exchange) => entry.assertions_failed),
    digestDiffers: differsFrom((entry: Exchange) => entry.assertions_failed),
  },
  {
    field: "failures",
    differs: failuresDiffer,
    // Deliberately null. The digest covers the verdict and not the sentence
    // explaining it, which is exactly why the digest's coverage is reported
    // alongside the comparison instead of being left to be inferred from it.
    digestDiffers: null,
  },
];

/** The fields `bundle_digest` reads, derived from the table so it cannot drift. */
export const DIGEST_EXCHANGE_FIELDS: readonly ExchangeField[] = FIELDS.filter(
  (rule) => rule.digestDiffers !== null,
).map((rule) => rule.field);

const ALL_EXCHANGE_FIELDS: readonly ExchangeField[] = FIELDS.map((rule) => rule.field);

/** What happened to one exchange or one unanswered question. */
export type DiffChange = "unchanged" | "changed" | "added" | "absent";

export interface ExchangeSummary {
  readonly status?: number | undefined;
  readonly assertions_passed: number;
  readonly assertions_failed: number;
  readonly failures: readonly string[];
}

export interface DiffedExchange {
  readonly name: string;
  readonly change: DiffChange;
  readonly changed_fields: readonly ExchangeField[];
  /** Whether a field `bundle_digest` reads moved, or the exchange itself did. */
  readonly verdict_changed: boolean;
  readonly before?: ExchangeSummary | undefined;
  readonly after?: ExchangeSummary | undefined;
}

export interface DiffedUnknown {
  readonly question: string;
  readonly change: DiffChange;
  /** The reason that pass gave, per side. */
  readonly before?: string | undefined;
  readonly after?: string | undefined;
}

export interface BundleIdentity {
  readonly bundle_id: string;
  readonly workspace_id: string;
  readonly status: VerificationStatus;
  readonly digest: string;
  /** The ask, echoed as the pass echoed it. */
  readonly goal?: string | undefined;
}

export interface BuildState {
  readonly succeeded: boolean;
  readonly exit_code: number;
}

export interface ServiceState {
  readonly ready: boolean;
  /** Reported, never compared: the caller picks the port. */
  readonly endpoint?: string | undefined;
}

export type BundleDiffOutcome = "identical" | "changed" | "incomparable";

const summarise = (entry: Exchange): ExchangeSummary => ({
  ...(entry.status === undefined ? {} : { status: entry.status }),
  assertions_passed: entry.assertions_passed,
  assertions_failed: entry.assertions_failed,
  failures: [...entry.failures],
});

/** One exchange, as the two passes recorded it. */
const compareExchange = (
  name: string,
  a: Exchange | undefined,
  b: Exchange | undefined,
): DiffedExchange => {
  if (a === undefined || b === undefined) {
    return {
      name,
      change: a === undefined ? "added" : "absent",
      // Everything the comparison reads has no counterpart on the other side,
      // and an exchange only one pass asked is a difference the digest sees:
      // its name is in the list the digest covers.
      changed_fields: [...ALL_EXCHANGE_FIELDS],
      verdict_changed: true,
      ...(a === undefined ? {} : { before: summarise(a) }),
      ...(b === undefined ? {} : { after: summarise(b) }),
    };
  }
  const changed_fields = FIELDS.filter((rule) => rule.differs(a, b)).map((rule) => rule.field);
  if (changed_fields.length === 0) {
    return { name, change: "unchanged", changed_fields: [], verdict_changed: false };
  }
  return {
    name,
    change: "changed",
    changed_fields,
    verdict_changed: FIELDS.some((rule) => rule.digestDiffers?.(a, b) === true),
    before: summarise(a),
    after: summarise(b),
  };
};

const diffUnverified = (
  a: ComparedBundle,
  b: ComparedBundle,
  includeUnchanged: boolean,
): { unchanged: number; entries: DiffedUnknown[] } => {
  const byQuestion = (bundle: ComparedBundle) =>
    new Map(bundle.unverified.map((entry) => [entry.question, entry.reason]));
  const left = byQuestion(a);
  const right = byQuestion(b);
  const questions = [...left.keys()];
  for (const question of right.keys()) if (!left.has(question)) questions.push(question);

  const entries: DiffedUnknown[] = [];
  let unchanged = 0;
  for (const question of questions) {
    const before = left.get(question);
    const after = right.get(question);
    if (before === after) {
      unchanged += 1;
      if (includeUnchanged) entries.push({ question, change: "unchanged" });
      continue;
    }
    entries.push({
      question,
      change: before === undefined ? "added" : after === undefined ? "absent" : "changed",
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    });
  }
  return { unchanged, entries };
};

/**
 * The exchanges of one pass, keyed by name.
 *
 * A pass names its exchanges from the caller's request names, so two requests
 * can share one. A map would quietly keep the last, and a comparison over a
 * silently shortened list is worse than no comparison, so the caller is told
 * instead — see `comparability`.
 */
const byName = (bundle: ComparedBundle): Map<string, Exchange> =>
  new Map(bundle.exchanges.map((entry) => [entry.name, entry]));

const duplicatesOf = (bundle: ComparedBundle): string[] => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const entry of bundle.exchanges) {
    if (seen.has(entry.name)) repeated.add(entry.name);
    seen.add(entry.name);
  }
  return [...repeated];
};

const diffExchanges = (
  a: ComparedBundle,
  b: ComparedBundle,
  includeUnchanged: boolean,
): { unchanged: number; entries: DiffedExchange[] } => {
  const left = byName(a);
  const right = byName(b);
  const names = [...new Set([...left.keys(), ...right.keys()])];

  const entries: DiffedExchange[] = [];
  let unchanged = 0;
  for (const name of names) {
    const entry = compareExchange(name, left.get(name), right.get(name));
    if (entry.change === "unchanged") {
      unchanged += 1;
      if (!includeUnchanged) continue;
    }
    entries.push(entry);
  }
  return { unchanged, entries };
};

/**
 * The order-sensitive content of a pass: what the digest hashes, in the order it
 * hashes it.
 *
 * `bundleDigest` maps over both lists as they stand, so a pass that asked the
 * same requests in a different order has a different digest. That is the fact
 * `order_changed` exists to report, and it is why this is a sequence and not a
 * set.
 */
const sequenceOf = (bundle: ComparedBundle): string[] => [
  ...bundle.exchanges.map((entry) => `exchange ${entry.name}`),
  ...bundle.unverified.map((entry) => `question ${entry.question}`),
];

const sameSequence = (a: ComparedBundle, b: ComparedBundle): boolean => {
  const left = sequenceOf(a);
  const right = sequenceOf(b);
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
};

/**
 * Whether a reordering is the only thing that moved.
 *
 * A pass that asked a different *set* of requests also changed the sequence, but
 * reporting that as a reordering would say nothing the per-exchange entries do
 * not already say — and it would print a line about order above a table whose
 * rows are named `added` and `absent`. So the reordering claim is made only when
 * the two lists hold the same entries.
 */
const reordered = (a: ComparedBundle, b: ComparedBundle): boolean => {
  const sameSet =
    JSON.stringify([...sequenceOf(a)].sort()) === JSON.stringify([...sequenceOf(b)].sort());
  return sameSet && !sameSequence(a, b);
};

const identityOf = (bundle: ComparedBundle): BundleIdentity => ({
  bundle_id: bundle.bundle_id,
  workspace_id: bundle.workspace_id,
  status: bundle.status,
  digest: bundle.bundle_digest,
  ...(bundle.goal === undefined ? {} : { goal: bundle.goal }),
});

const comparability = (a: ComparedBundle, b: ComparedBundle): string[] => {
  const reasons: string[] = [];
  if (a.workspace_id !== b.workspace_id) {
    reasons.push(
      `the two passes were made in different workspaces (${a.workspace_id} and ` +
        `${b.workspace_id}), so a difference between them is two subjects rather than a ` +
        "change in one",
    );
  }
  const inconsistent = [
    ...(bundleDigest(a) === a.bundle_digest ? [] : ["before"]),
    ...(bundleDigest(b) === b.bundle_digest ? [] : ["after"]),
  ];
  if (inconsistent.length > 0) {
    reasons.push(
      `the ${inconsistent.join(" and ")} bundle's supplied digest does not match the one its own ` +
        "contents produce, so it cannot be relied on as a record: the fields below are what it " +
        "says, not what it is",
    );
  }
  for (const [side, bundle] of [
    ["before", a],
    ["after", b],
  ] as const) {
    const repeated = duplicatesOf(bundle);
    if (repeated.length > 0) {
      reasons.push(
        `the ${side} pass recorded ${String(repeated.length)} exchange name(s) more than once ` +
          `(${repeated.join(", ")}), so its exchanges cannot be matched up by name with ` +
          "another pass's",
      );
    }
  }
  return reasons;
};

/**
 * Compare two passes.
 *
 * `includeUnchanged` decides whether the entries are the differences or every
 * exchange the two passes have between them. Both are records of the same two
 * bundles; the flag chooses which reading the caller is asking for, and the
 * counts are reported either way so a difference is never invisible because it
 * was filtered out.
 */
export const diffBundles = (
  before: ComparedBundle,
  after: ComparedBundle,
  options: { readonly includeUnchanged: boolean },
): BundleDiff => {
  const reasons = comparability(before, after);
  const digestConsistent = {
    before: bundleDigest(before) === before.bundle_digest,
    after: bundleDigest(after) === after.bundle_digest,
  };
  const exchanges = diffExchanges(before, after, options.includeUnchanged);
  const unverified = diffUnverified(before, after, options.includeUnchanged);
  const build = {
    before: { succeeded: before.build.succeeded, exit_code: before.build.exit_code },
    after: { succeeded: after.build.succeeded, exit_code: after.build.exit_code },
  };
  const service = {
    before: {
      ready: before.service.ready,
      ...(before.service.endpoint === undefined ? {} : { endpoint: before.service.endpoint }),
    },
    after: {
      ready: after.service.ready,
      ...(after.service.endpoint === undefined ? {} : { endpoint: after.service.endpoint }),
    },
  };
  const buildChanged =
    build.before.succeeded !== build.after.succeeded ||
    build.before.exit_code !== build.after.exit_code;
  const serviceChanged = service.before.ready !== service.after.ready;
  const orderChanged = reordered(before, after);

  const changed =
    exchanges.entries.some((entry) => entry.change !== "unchanged") ||
    unverified.entries.some((entry) => entry.change !== "unchanged") ||
    before.status !== after.status ||
    buildChanged ||
    serviceChanged ||
    orderChanged;

  const outcome: BundleDiffOutcome =
    reasons.length > 0 ? "incomparable" : changed ? "changed" : "identical";

  return {
    before: identityOf(before),
    after: identityOf(after),
    comparable: reasons.length === 0,
    incomparable_because: reasons,
    digest_consistent: digestConsistent,
    // Undefined rather than false when a digest is inconsistent: two digests one
    // of which does not describe its own bundle have not been found equal, and
    // reporting `false` would claim a comparison that was never made.
    same_digest:
      digestConsistent.before && digestConsistent.after
        ? before.bundle_digest === after.bundle_digest
        : undefined,
    outcome,
    status_changed: before.status !== after.status,
    // The ask, not a finding: reported, and it does not make the outcome
    // `changed` on its own.
    goal_changed: before.goal !== after.goal,
    order_changed: orderChanged,
    build: { changed: buildChanged, ...build },
    service: { changed: serviceChanged, ...service },
    exchanges: {
      unchanged: exchanges.unchanged,
      before_count: before.exchanges.length,
      after_count: after.exchanges.length,
      entries: exchanges.entries,
    },
    unverified: {
      unchanged: unverified.unchanged,
      before_count: before.unverified.length,
      after_count: after.unverified.length,
      entries: unverified.entries,
    },
    not_compared: ["bundle_id", "exchange_id", "elapsed_ms", "service.run_id", "service.endpoint"],
    limitations: limitationsFor({
      outcome,
      changed,
      orderChanged,
      before,
      after,
      digestConsistent,
    }),
  };
};

export interface BundleDiff {
  readonly before: BundleIdentity;
  readonly after: BundleIdentity;
  readonly comparable: boolean;
  readonly incomparable_because: readonly string[];
  /** Whether each supplied digest equals the one its own contents produce. */
  readonly digest_consistent: { readonly before: boolean; readonly after: boolean };
  /** Absent when either digest is inconsistent with its own bundle. */
  readonly same_digest: boolean | undefined;
  readonly outcome: BundleDiffOutcome;
  readonly status_changed: boolean;
  /** The ask rather than a finding; it does not by itself change the outcome. */
  readonly goal_changed: boolean;
  /** Whether the order the exchanges and questions were recorded in moved. */
  readonly order_changed: boolean;
  readonly build: {
    readonly changed: boolean;
    readonly before: BuildState;
    readonly after: BuildState;
  };
  readonly service: {
    readonly changed: boolean;
    readonly before: ServiceState;
    readonly after: ServiceState;
  };
  readonly exchanges: {
    readonly unchanged: number;
    readonly before_count: number;
    readonly after_count: number;
    readonly entries: readonly DiffedExchange[];
  };
  readonly unverified: {
    readonly unchanged: number;
    readonly before_count: number;
    readonly after_count: number;
    readonly entries: readonly DiffedUnknown[];
  };
  /** Fields present in the report that were deliberately not judged. */
  readonly not_compared: readonly string[];
  readonly limitations: readonly string[];
}

/**
 * What a reader of this comparison needs to know that the numbers cannot say.
 *
 * Written per outcome rather than as a fixed paragraph, because the paragraph
 * that matters is the one about *this* result: a reader who sees
 * `same_digest: true` beside `outcome: changed` needs the sentence explaining
 * that pairing, and a reader of an `identical` pair does not.
 */
const limitationsFor = (init: {
  readonly outcome: BundleDiffOutcome;
  readonly changed: boolean;
  readonly orderChanged: boolean;
  readonly before: ComparedBundle;
  readonly after: ComparedBundle;
  readonly digestConsistent: { readonly before: boolean; readonly after: boolean };
}): string[] => {
  const limitations = [
    "This compares two reports of two passes and observes nothing itself, so a difference here is " +
      "a difference between the two records, not a measurement of the subject now.",
    "Identifiers and the clock are reported and never compared: `bundle_id`, `exchange_id` and " +
      "`service.run_id` are minted per pass, and `elapsed_ms` and `service.endpoint` are facts " +
      "about the run rather than about the subject, so all of them differ between two passes that " +
      "established the same things.",
  ];
  if (init.orderChanged) {
    limitations.push(
      "The two passes recorded their exchanges or their unanswered questions in a different order. " +
        "The sequence is part of what `bundle_digest` covers, so the digests differ even when the " +
        "same requests produced the same results; whether that order is a difference in the " +
        "subject is not something this comparison can decide.",
    );
  }
  if (
    init.digestConsistent.before &&
    init.digestConsistent.after &&
    init.before.bundle_digest === init.after.bundle_digest &&
    init.changed
  ) {
    limitations.push(
      "The two digests agree, so nothing `bundle_digest` covers moved. What differs is outside it: " +
        `the digest reads ${DIGEST_EXCHANGE_FIELDS.join(", ")} for each exchange and not the ` +
        "failure text, nor the build and service state.",
    );
  }
  if (init.outcome === "incomparable") {
    limitations.push(
      "Every field is reported anyway, because a record of what each pass said is worth having. " +
        "What the outcome withholds is reading those fields as a change in one subject.",
    );
  }
  if (init.before.goal !== init.after.goal) {
    limitations.push(
      "The two passes state different goals. A goal is the ask rather than a finding, so it is " +
        "reported and does not by itself make the outcome `changed`; what is compared is the set " +
        "of requests and what they established.",
    );
  }
  return limitations;
};
