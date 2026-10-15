import { ASSERTION_KINDS } from "../domain/assertionKinds.js";
import type { AssertionKind } from "../domain/assertionKinds.js";
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
  readonly passed: boolean;
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

const parseJsonBody = (record: ExchangeRecord): { parsed: boolean; value: unknown } => {
  const text = bodyText(record);
  if (text === undefined || text.length === 0) return { parsed: false, value: undefined };
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false, value: undefined };
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
  readonly passed: boolean;
  readonly observed: unknown;
  readonly message: string;
}

type RawEvaluator = (record: ExchangeRecord, spec: AssertionSpec) => RawOutcome;

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
  if (observed === undefined) {
    return { passed: false, observed, message: "no response status was recorded" };
  }
  return {
    passed: looseEquals(observed, spec.expected),
    observed,
    message: `status ${String(observed)}`,
  };
};

const statusIn: RawEvaluator = (record, spec) => {
  const allowed = Array.isArray(spec.expected) ? spec.expected : [];
  const observed = record.status;
  return {
    passed: observed !== undefined && allowed.some((value) => looseEquals(observed, value)),
    observed,
    // Observation, then expectation. Phrased the other way round — "status 418
    // in [200, 204]" — the text reads as a true statement about a membership
    // test that just failed, and this message is what a caller is shown as the
    // reason for the failure.
    message: `status ${String(observed)}, expected one of [${allowed.map(String).join(", ")}]`,
  };
};

const headerOf = (record: ExchangeRecord, spec: AssertionSpec): [string, string | undefined] => {
  const name = (spec.target ?? "").toLowerCase();
  return [name, record.responseHeaders[name]];
};

const headerEquals: RawEvaluator = (record, spec) => {
  const [name, observed] = headerOf(record, spec);
  if (observed === undefined)
    return { passed: false, observed, message: `header ${name} is absent` };
  return {
    passed: looseEquals(observed, spec.expected),
    observed,
    message: `header ${name}=${observed}`,
  };
};

const headerExists: RawEvaluator = (record, spec) => {
  const [name, observed] = headerOf(record, spec);
  return {
    passed: observed !== undefined,
    observed,
    // The outcome decides the wording. A `header_exists` assertion fails
    // precisely when the header is absent, so a message that always reads
    // "present" would report the opposite of what was found.
    message: observed === undefined ? `header ${name} is absent` : `header ${name} is present`,
  };
};

const headerMatches: RawEvaluator = (record, spec) => {
  const [name, observed] = headerOf(record, spec);
  if (observed === undefined)
    return { passed: false, observed, message: `header ${name} is absent` };
  const pattern = typeof spec.expected === "string" ? spec.expected : "";
  const { matched, invalid } = matchPattern(pattern, observed);
  if (invalid !== undefined) {
    return { passed: false, observed, message: `invalid regular expression: ${invalid}` };
  }
  return {
    passed: matched,
    observed,
    message: `header ${name}=${observed}, expected /${pattern}/`,
  };
};

const bodyContains: RawEvaluator = (record, spec) => {
  const observed = bodyText(record);
  const needle = asText(spec.expected);
  return {
    passed: observed !== undefined && observed.includes(needle),
    observed: observed === undefined ? undefined : observed.slice(0, 512),
    message: `body length ${String(observed?.length ?? 0)}, expected to contain ${JSON.stringify(needle)}`,
  };
};

const bodyMatches: RawEvaluator = (record, spec) => {
  const observed = bodyText(record);
  if (observed === undefined) {
    return { passed: false, observed: undefined, message: "no response body was recorded" };
  }
  const pattern = typeof spec.expected === "string" ? spec.expected : "";
  const { matched, invalid } = matchPattern(pattern, observed);
  if (invalid !== undefined) {
    return {
      passed: false,
      observed: undefined,
      message: `invalid regular expression: ${invalid}`,
    };
  }
  return {
    passed: matched,
    observed: observed.slice(0, 512),
    message: `body length ${String(observed.length)}, expected to match /${pattern}/`,
  };
};

/** Resolve the JSONPath both JSON assertions share, or explain why it did not run. */
const jsonPathValue = (
  record: ExchangeRecord,
  spec: AssertionSpec,
): { ok: true; value: unknown; path: string } | { ok: false; message: string } => {
  const path = spec.target ?? "$";
  const { parsed, value } = parseJsonBody(record);
  if (!parsed) return { ok: false, message: "response body is not valid JSON" };
  const result = evaluateJsonPath(value, path);
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
  if (!resolved.ok) return { passed: false, observed: undefined, message: resolved.message };
  // The expectation is in the message, as it is in every sibling evaluator's.
  // In a verification bundle the message is the *only* place a failure is
  // described — `exchanges[].failures` is a list of strings — so a message that
  // reports what was there and not what was asked for leaves a reader who did
  // not write the assertion with nothing to compare against.
  const expectation = shown(spec.expected);
  return {
    passed: looseEquals(resolved.value, spec.expected),
    observed: resolved.value,
    message:
      resolved.value === undefined
        ? `${resolved.path} is absent, expected ${expectation}`
        : `${resolved.path} = ${shown(resolved.value)}, expected ${expectation}`,
  };
};

const bodyJsonPathExists: RawEvaluator = (record, spec) => {
  const resolved = jsonPathValue(record, spec);
  if (!resolved.ok) return { passed: false, observed: undefined, message: resolved.message };
  return {
    passed: resolved.value !== undefined,
    observed: resolved.value,
    message:
      resolved.value === undefined
        ? `${resolved.path} is absent`
        : `${resolved.path} = ${JSON.stringify(resolved.value)}`,
  };
};

const bodyBytesUnder: RawEvaluator = (record, spec) => {
  const observed = record.responseBody?.byteLength ?? 0;
  const limit = asNumber(spec.expected);
  return {
    passed: observed < limit,
    observed,
    message: `body ${String(observed)} bytes, limit ${String(limit)}`,
  };
};

const latencyUnderMs: RawEvaluator = (record, spec) => {
  const observed = record.durationMs;
  const limit = asNumber(spec.expected);
  return {
    passed: observed < limit,
    observed,
    message: `latency ${String(observed)} ms, limit ${String(limit)}`,
  };
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
    return {
      passed: false,
      observed,
      message: `no http version was recorded, expected ${expectation}`,
    };
  }
  return {
    passed: observed === spec.expected,
    observed,
    // Exact, not `looseEquals`: `"2.0"` and `"2"` are the observed and the
    // requested spellings of one protocol, and treating them as equal here is
    // exactly the confusion this assertion exists to catch.
    message: `http version ${observed}, expected ${expectation}`,
  };
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
    passed: negated ? !raw.passed : raw.passed,
    observed: raw.observed,
    message: negated ? `negated: ${raw.message}` : raw.message,
  };
};

export const evaluateAssertions = (
  record: ExchangeRecord,
  specs: readonly AssertionSpec[],
): readonly AssertionOutcome[] => specs.map((spec) => evaluateAssertion(record, spec));

/** Percentile over an already-collected sample, using nearest-rank. */
export const percentile = (sortedSamples: readonly number[], fraction: number): number => {
  if (sortedSamples.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedSamples.length);
  const index = Math.min(sortedSamples.length - 1, Math.max(0, rank - 1));
  return sortedSamples[index] ?? 0;
};
