import { ASSERTION_KINDS } from "../domain/assertionKinds.js";
import type { AssertionKind } from "../domain/assertionKinds.js";
import { negateVerdict } from "../domain/verdict.js";
import type { VerdictStatus } from "../domain/verdict.js";
import type { ExchangeRecord } from "./sessionStore.js";

/**
 * The assertion engine.
 *
 * Every assertion returns the value it actually observed, not only whether it
 * matched. A failing check that reports `expected 200, got undefined` is worth
 * far more than one that reports `status_equals: false`, because the first
 * tells the caller whether the request even completed.
 */

/**
 * The vocabulary itself lives in `domain`, because the contracts that validate a
 * request and the CLI syntax that lowers onto it name the same closed set. This
 * module implements it; it does not declare it. Re-exported here so the
 * evaluator's own callers keep one import for "the assertions module".
 */
export { ASSERTION_KINDS };
export type { AssertionKind };

export interface AssertionSpec {
  readonly kind: AssertionKind;
  readonly target?: string;
  readonly expected?: unknown;
  readonly negate?: boolean;
}

export interface AssertionOutcome {
  readonly kind: AssertionKind;
  readonly target: string | undefined;
  /**
   * What the check came to.
   *
   * Two states were not enough. An exchange whose request never completed has no
   * status to compare, an HTTP/3 record carries only the response headers the
   * probe asked for by name, and a caller-supplied pattern can be invalid — in
   * all three the engine did not reach a verdict, and `passed: false` reports
   * that as a verdict against the service. The caller's next move differs in
   * each case, so the difference is a field rather than a word inside
   * `message`: a bundle counts failed assertions, and a check that never ran
   * must not be counted among them.
   *
   * Carried as the shared [`VerdictStatus`] rather than as `passed` beside an
   * `evaluated` flag, because the tool that reports these rows and the tool that
   * reports a feature's availability answer the same question, and their third
   * states have to be the same word.
   */
  readonly status: VerdictStatus;
  readonly observed: unknown;
  readonly expected: unknown;
  readonly message: string;
}

/**
 * Minimal JSONPath.
 *
 * Supports `$`, `.field`, `["field"]`, and `[index]`. Anything beyond that is
 * reported as unsupported rather than silently returning undefined, because a
 * path the engine cannot evaluate and a path that resolved to nothing are
 * different facts.
 */
export const evaluateJsonPath = (
  document: unknown,
  path: string,
): { found: boolean; value: unknown; unsupported?: string } => {
  if (!path.startsWith("$"))
    return { found: false, value: undefined, unsupported: "path must start with $" };
  let current: unknown = document;
  let index = 1;
  while (index < path.length) {
    const char = path[index];
    if (char === ".") {
      const match = /^\.([A-Za-z_$][A-Za-z0-9_$]*)/u.exec(path.slice(index));
      if (match?.[1] === undefined) return { found: false, value: undefined, unsupported: path };
      current = isRecord(current) ? current[match[1]] : undefined;
      index += match[0].length;
      continue;
    }
    if (char === "[") {
      const close = path.indexOf("]", index);
      if (close < 0) return { found: false, value: undefined, unsupported: path };
      const inner = path.slice(index + 1, close);
      const key = /^["'](.*)["']$/u.exec(inner)?.[1];
      if (key !== undefined) {
        current = isRecord(current) ? current[key] : undefined;
      } else if (/^\d+$/u.test(inner)) {
        current = Array.isArray(current) ? current[Number(inner)] : undefined;
      } else {
        return { found: false, value: undefined, unsupported: path };
      }
      index = close + 1;
      continue;
    }
    return { found: false, value: undefined, unsupported: path };
  }
  return { found: true, value: current };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const bodyText = (record: ExchangeRecord): string | undefined =>
  record.responseBody === undefined ? undefined : record.responseBody.toString("utf8");

/**
 * Parse the body, or say why there is nothing to parse.
 *
 * An absent body and an unparseable one are separate reasons: `<html>` is a body
 * the service sent that is not JSON, while an empty body is not a JSON document
 * that failed to parse. Both stop a JSONPath assertion, and a caller reading
 * "not valid JSON" about a body that was never recorded is reading a claim about
 * content that does not exist.
 */
const parseJsonBody = (
  record: ExchangeRecord,
): { parsed: true; value: unknown } | { parsed: false; reason: string } => {
  const text = bodyText(record);
  if (text === undefined || text.length === 0) {
    return { parsed: false, reason: "no response body was recorded" };
  }
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false, reason: "response body is not valid JSON" };
  }
};

/** True when the actual value satisfies the expected value under `==`-like rules. */
const looseEquals = (actual: unknown, expected: unknown): boolean => {
  if (actual === expected) return true;
  if (typeof actual === "number" && typeof expected === "number") return actual === expected;
  if (actual === null || actual === undefined) return false;
  return String(actual) === String(expected);
};

/**
 * What an evaluator reports before negation is applied.
 *
 * Kept separate from `AssertionOutcome` so that negating an assertion is done in
 * exactly one place. A `negate` handled inside each evaluator would be handled
 * correctly in ten of them and incorrectly in the eleventh.
 */
interface RawOutcome {
  readonly status: VerdictStatus;
  readonly observed: unknown;
  readonly message: string;
}

type RawEvaluator = (record: ExchangeRecord, spec: AssertionSpec) => RawOutcome;

/**
 * The verdict of a check that ran.
 *
 * A helper rather than a literal at each site, because `status` here is the
 * claim each evaluator is making: it read the fact it was asked about and the
 * fact decided the outcome. A site that cannot make that claim returns
 * `notEvaluated` instead, and the two functions are the only way to build a
 * `RawOutcome`.
 */
const verdict = (passed: boolean, observed: unknown, message: string): RawOutcome => ({
  status: passed ? "satisfied" : "unmet",
  observed,
  message,
});

/**
 * A check that could not run, with the reason and nothing else.
 *
 * `unmet` would be a claim about the service; this is a fact about the record or
 * the request, which is what everything routed through this function carries.
 */
const notEvaluated = (message: string, observed: unknown = undefined): RawOutcome => ({
  status: "undetermined",
  observed,
  message,
});

const asText = (value: unknown): string => (typeof value === "string" ? value : String(value));

const asNumber = (value: unknown): number => (typeof value === "number" ? value : Number(value));

/** Match a pattern, reporting a bad pattern as a failure rather than throwing. */
const matchPattern = (pattern: string, subject: string): { matched: boolean; invalid?: string } => {
  try {
    return { matched: new RegExp(pattern, "u").test(subject) };
  } catch {
    return { matched: false, invalid: pattern };
  }
};

const statusEquals: RawEvaluator = (record, spec) => {
  const observed = record.status;
  // No status line was parsed, so there was no status to compare. Reading
  // `undefined` as "not 200" reports a request that never completed as a
  // response of the wrong status, which is a finding about the service.
  if (observed === undefined) return notEvaluated("no response status was recorded");
  return verdict(looseEquals(observed, spec.expected), observed, `status ${String(observed)}`);
};

const statusIn: RawEvaluator = (record, spec) => {
  const allowed = Array.isArray(spec.expected) ? spec.expected : [];
  const observed = record.status;
  const membership = `expected one of [${allowed.map(String).join(", ")}]`;
  if (observed === undefined) return notEvaluated(`no response status was recorded, ${membership}`);
  return verdict(
    allowed.some((value) => looseEquals(observed, value)),
    observed,
    // Observation, then expectation. Phrased the other way round — "status 418
    // in [200, 204]" — the text reads as a true statement about a membership
    // test that just failed, and this message is what a caller is shown as the
    // reason for the failure.
    `status ${String(observed)}, ${membership}`,
  );
};

/**
 * The response header a spec names, and whether it was looked for at all.
 *
 * Three outcomes, not two, because two of them are different facts with different
 * remedies. `observed` set means the header was read. `observed` absent with
 * `lookedAt` true means the peer did not send it. `observed` absent with
 * `lookedAt` false means nobody asked — the client that made the request reads
 * response headers one name at a time, and this name was not on its list.
 * Reporting the third as the second is the failure this exists to prevent: it
 * turns "uvp did not look" into "the service did not send", which is a finding
 * about a service derived from a gap in the tool.
 */
const headerOf = (
  record: ExchangeRecord,
  spec: AssertionSpec,
): { readonly name: string; readonly observed: string | undefined; readonly lookedAt: boolean } => {
  const name = (spec.target ?? "").toLowerCase();
  return {
    name,
    observed: record.responseHeaders[name],
    lookedAt: record.responseHeadersObserved?.includes(name) ?? true,
  };
};

/**
 * Why a header assertion could not be evaluated, or nothing when it could.
 *
 * The list of names that *were* read is part of the message, because the caller's
 * next question is always "then which ones can I assert on".
 */
const notLookedAt = (record: ExchangeRecord, name: string): string =>
  `header ${name} was not looked at: this exchange read only ${(
    record.responseHeadersObserved ?? []
  )
    .map((entry) => `\`${entry}\``)
    .join(
      ", ",
    )}, and a name outside that list is a header nobody asked for rather than one the peer left out`;

const headerEquals: RawEvaluator = (record, spec) => {
  const { name, observed, lookedAt } = headerOf(record, spec);
  if (!lookedAt) return notEvaluated(notLookedAt(record, name), observed);
  // The name was read and the peer did not send it: a fact about the response,
  // and a failure of this assertion.
  if (observed === undefined) return verdict(false, observed, `header ${name} is absent`);
  return verdict(looseEquals(observed, spec.expected), observed, `header ${name}=${observed}`);
};

const headerExists: RawEvaluator = (record, spec) => {
  const { name, observed, lookedAt } = headerOf(record, spec);
  if (!lookedAt) return notEvaluated(notLookedAt(record, name), observed);
  return verdict(
    observed !== undefined,
    observed,
    // The outcome decides the wording. A `header_exists` assertion fails
    // precisely when the header is absent, so a message that always reads
    // "present" would report the opposite of what was found.
    observed === undefined ? `header ${name} is absent` : `header ${name} is present`,
  );
};

const headerMatches: RawEvaluator = (record, spec) => {
  const { name, observed, lookedAt } = headerOf(record, spec);
  if (!lookedAt) return notEvaluated(notLookedAt(record, name), observed);
  if (observed === undefined) return verdict(false, observed, `header ${name} is absent`);
  const pattern = typeof spec.expected === "string" ? spec.expected : "";
  const { matched, invalid } = matchPattern(pattern, observed);
  // A pattern that does not compile is a check that did not run. Reported as a
  // failure it would read as "the header did not match", which is a statement
  // about a value nobody compared — and under `negate` it read as a pass.
  if (invalid !== undefined) {
    return notEvaluated(`invalid regular expression: ${invalid}`, observed);
  }
  return verdict(matched, observed, `header ${name}=${observed}, expected /${pattern}/`);
};

const bodyContains: RawEvaluator = (record, spec) => {
  const observed = bodyText(record);
  const needle = asText(spec.expected);
  const expectation = `expected to contain ${JSON.stringify(needle)}`;
  // The body is what a substring search needs and it is not here. Reading the
  // absent body as zero bytes reported `body length 0` — a length for a body
  // that was never recorded, and the number that makes a `body_bytes_under`
  // assertion pass.
  if (observed === undefined) return notEvaluated(`no response body was recorded, ${expectation}`);
  return verdict(
    observed.includes(needle),
    observed.slice(0, 512),
    `body length ${String(observed.length)}, ${expectation}`,
  );
};

const bodyMatches: RawEvaluator = (record, spec) => {
  const observed = bodyText(record);
  if (observed === undefined) return notEvaluated("no response body was recorded");
  const pattern = typeof spec.expected === "string" ? spec.expected : "";
  const { matched, invalid } = matchPattern(pattern, observed);
  if (invalid !== undefined) {
    return notEvaluated(`invalid regular expression: ${invalid}`, observed.slice(0, 512));
  }
  return verdict(
    matched,
    observed.slice(0, 512),
    `body length ${String(observed.length)}, expected to match /${pattern}/`,
  );
};

/** Resolve the JSONPath both JSON assertions share, or explain why it did not run. */
const jsonPathValue = (
  record: ExchangeRecord,
  spec: AssertionSpec,
): { ok: true; value: unknown; path: string } | { ok: false; message: string } => {
  const path = spec.target ?? "$";
  const body = parseJsonBody(record);
  if (!body.parsed) return { ok: false, message: body.reason };
  const result = evaluateJsonPath(body.value, path);
  if (result.unsupported !== undefined) {
    return { ok: false, message: `unsupported JSONPath: ${result.unsupported}` };
  }
  return { ok: true, value: result.value, path };
};

/**
 * A value as a caller reads it in a message.
 *
 * `undefined` is not a JSON word, and it is what a template literal produces for
 * an absent path — `$.nope = undefined`, which reads as a value the body held.
 * The path is absent, and saying so is the whole point of reporting it.
 */
const shown = (value: unknown): string => (value === undefined ? "absent" : JSON.stringify(value));

const bodyJsonPathEquals: RawEvaluator = (record, spec) => {
  const resolved = jsonPathValue(record, spec);
  // Nothing was resolved, so nothing was compared: the body is absent, is not
  // JSON, or holds a path this engine cannot walk. All three are limits of the
  // check, not values that differed from the expectation.
  if (!resolved.ok) return notEvaluated(resolved.message);
  // The expectation is in the message, as it is in every sibling evaluator's.
  // In a verification bundle the message is the *only* place a failure is
  // described — `exchanges[].failures` is a list of strings — so a message that
  // reports what was there and not what was asked for leaves a reader who did
  // not write the assertion with nothing to compare against.
  const expectation = shown(spec.expected);
  return verdict(
    looseEquals(resolved.value, spec.expected),
    resolved.value,
    resolved.value === undefined
      ? `${resolved.path} is absent, expected ${expectation}`
      : `${resolved.path} = ${shown(resolved.value)}, expected ${expectation}`,
  );
};

const bodyJsonPathExists: RawEvaluator = (record, spec) => {
  const resolved = jsonPathValue(record, spec);
  if (!resolved.ok) return notEvaluated(resolved.message);
  return verdict(
    resolved.value !== undefined,
    resolved.value,
    resolved.value === undefined
      ? `${resolved.path} is absent`
      : `${resolved.path} = ${JSON.stringify(resolved.value)}`,
  );
};

const bodyBytesUnder: RawEvaluator = (record, spec) => {
  const limit = asNumber(spec.expected);
  // `?? 0` reported a body nobody recorded as zero bytes, and zero is under
  // every positive limit — so this assertion passed on an exchange whose
  // request never completed. The size of a body that is not there is not a
  // number, and no limit can be measured against it.
  const observed = record.responseBody?.byteLength;
  if (observed === undefined) {
    return notEvaluated(`no response body was recorded, limit ${String(limit)} bytes`);
  }
  return verdict(
    observed < limit,
    observed,
    `body ${String(observed)} bytes, limit ${String(limit)}`,
  );
};

const latencyUnderMs: RawEvaluator = (record, spec) => {
  const observed = record.durationMs;
  const limit = asNumber(spec.expected);
  // A record with no status is a request that never got a response line, and
  // the duration it carries is the time until it failed. Comparing that to a
  // latency limit reports a connection failure as a fast service.
  if (record.status === undefined) {
    return notEvaluated(`no response was recorded, limit ${String(limit)} ms`, observed);
  }
  return verdict(
    observed < limit,
    observed,
    `latency ${String(observed)} ms, limit ${String(limit)}`,
  );
};

/**
 * The protocol version the response came back in.
 *
 * `undefined` is a real state and is not a failure of the assertion: an exchange
 * whose request never completed has no response, so nothing negotiated anything.
 * Reporting it as `expected "2.0"` with no observation would read as a service
 * that answered over something else; saying no version was recorded is the fact.
 */
const httpVersionEquals: RawEvaluator = (record, spec) => {
  const observed = record.httpVersion;
  const expectation = shown(spec.expected);
  if (observed === undefined) {
    return notEvaluated(`no http version was recorded, expected ${expectation}`);
  }
  return verdict(
    observed === spec.expected,
    observed,
    // Exact, not `looseEquals`: `"2.0"` and `"2"` are the observed and the
    // requested spellings of one protocol, and treating them as equal here is
    // exactly the confusion this assertion exists to catch.
    `http version ${observed}, expected ${expectation}`,
  );
};

/**
 * One evaluator per kind, in a table rather than a switch.
 *
 * The table is `Record<AssertionKind, …>`, so a new kind in `ASSERTION_KINDS`
 * without an evaluator is a compile error. The switch it replaced had a `default`
 * branch that failed at runtime instead, which is the wrong moment to find out.
 */
const EVALUATORS: Record<AssertionKind, RawEvaluator> = {
  status_equals: statusEquals,
  status_in: statusIn,
  header_equals: headerEquals,
  header_matches: headerMatches,
  header_exists: headerExists,
  body_contains: bodyContains,
  body_matches: bodyMatches,
  body_json_path_equals: bodyJsonPathEquals,
  body_json_path_exists: bodyJsonPathExists,
  body_bytes_under: bodyBytesUnder,
  latency_under_ms: latencyUnderMs,
  http_version_equals: httpVersionEquals,
};

export const evaluateAssertion = (
  record: ExchangeRecord,
  spec: AssertionSpec,
): AssertionOutcome => {
  const raw = EVALUATORS[spec.kind](record, spec);
  const negated = spec.negate === true;
  return {
    kind: spec.kind,
    target: spec.target,
    expected: spec.expected,
    // Negation is not applied to a check that did not run. `!false` is `true`,
    // so a negated assertion over an exchange the engine could not read
    // reported a pass — the one outcome here that claims the most while resting
    // on nothing. A `!header:…` against a name nobody looked at, and a
    // `!body~=…` against a body that was never recorded, both used to pass.
    // `negateVerdict` leaves `undetermined` alone for that reason.
    status: negated ? negateVerdict(raw.status) : raw.status,
    observed: raw.observed,
    message: negated ? `negated: ${raw.message}` : raw.message,
  };
};

export const evaluateAssertions = (
  record: ExchangeRecord,
  specs: readonly AssertionSpec[],
): readonly AssertionOutcome[] => specs.map((spec) => evaluateAssertion(record, spec));

/** A value as it fits in a question, capped so a document cannot become one. */
const brief = (value: unknown): string => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length <= 80 ? text : `${text.slice(0, 80)}…`;
};

/**
 * The question a check that could not run leaves behind.
 *
 * Written from the caller's own assertion rather than from the engine's message,
 * because the message is the *reason* and goes in the `blocked_by` of the
 * unknown this becomes; the question is the line a reader sees first, and it has
 * to name the check that was asked for and not made. `subject` says which
 * exchange it was asked of, since one verification pass asks the same assertion
 * of several, and a list of identical questions would be unreadable.
 */
export const unevaluatedQuestion = (
  outcome: {
    readonly kind: string;
    readonly target?: string | undefined;
    readonly expected?: unknown;
  },
  subject: string,
): string =>
  `Does ${[
    `\`${outcome.kind}\``,
    ...(outcome.target === undefined ? [] : [`on \`${outcome.target}\``]),
    ...(outcome.expected === undefined ? [] : [`(${brief(outcome.expected)})`]),
  ].join(" ")} hold ${subject}?`;

/** Percentile over an already-collected sample, using nearest-rank. */
export const percentile = (sortedSamples: readonly number[], fraction: number): number => {
  if (sortedSamples.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedSamples.length);
  const index = Math.min(sortedSamples.length - 1, Math.max(0, rank - 1));
  return sortedSamples[index] ?? 0;
};
