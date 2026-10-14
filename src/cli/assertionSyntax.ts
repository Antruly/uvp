import { flagError } from "./args.js";

/**
 * The `--assert` mini-language.
 *
 * A shell makes every assertion a single argument, and a JSON assertion object
 * typed on a command line is unreadable. So the CLI accepts the compact forms the
 * documentation lists — `status=200`, `json:$.value=first`,
 * `header:content-type=application/json`, `body~=substring`, `latency<250ms` —
 * and lowers them to the contract's assertion objects.
 *
 * Lowering, not reimplementing. The resulting `{kind, target, expected}` goes
 * through the same evaluator as an MCP caller's assertion, so a CLI assertion and
 * a tool assertion that look the same are the same check. The syntax is the only
 * thing that differs.
 *
 * The evaluator's kind vocabulary is larger than this syntax covers; a caller who
 * needs `body_bytes_under` or a negated match can pass it as JSON with `--assert
 * '{"kind": …}'`. That escape hatch is documented in `--help` rather than left to
 * be discovered, because a syntax that silently cannot express something is how
 * people conclude the tool is limited.
 */

export interface AssertionInput {
  readonly kind: string;
  readonly target?: string;
  readonly expected?: unknown;
  readonly negate?: boolean;
}

const STATUS_CLASSES: Readonly<Record<string, readonly number[]>> = {
  "1xx": [100, 101, 102, 103],
  "2xx": [200, 201, 202, 203, 204, 205, 206, 207, 208, 226],
  "3xx": [300, 301, 302, 303, 304, 305, 307, 308],
  "4xx": [
    400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418,
    421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
  ],
  "5xx": [500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511],
};

/** A value the caller typed: JSON when it parses as JSON, a string otherwise. */
const literal = (raw: string): unknown => {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
};

/** Duration as `250ms`, `2s`, or bare milliseconds. */
const durationMs = (raw: string): number => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/u.exec(raw.trim());
  if (match === null) {
    flagError(`"${raw}" is not a duration. Use 250ms, 2s, or a number of milliseconds.`);
  }
  const value = Number(match[1]);
  switch (match[2]) {
    case "s":
      return Math.round(value * 1000);
    case "m":
      return Math.round(value * 60_000);
    default:
      return Math.round(value);
  }
};

const first = (text: string, characters: readonly string[]): { at: number; character: string } => {
  let best = -1;
  let chosen = "";
  for (const character of characters) {
    const index = text.indexOf(character);
    if (index !== -1 && (best === -1 || index < best)) {
      best = index;
      chosen = character;
    }
  }
  return { at: best, character: chosen };
};

/**
 * Lower one `--assert` argument.
 *
 * `!` is stripped before anything else, so negation means the same thing in
 * every form. It used to be stripped after the JSON escape hatch was tested,
 * which sent `!{…}` to the comparison parser — a JSON object contains no `=`, so
 * it was rejected with advice to pass "a JSON object", which is what the caller
 * had just passed, while the spelling that does work went unmentioned.
 */
export const parseAssertion = (text: string): AssertionInput => {
  const trimmed = text.trim();
  const negate = trimmed.startsWith("!") ? true : undefined;
  const body = negate === true ? trimmed.slice(1).trim() : trimmed;

  // An argument that begins with `{` is a JSON assertion object, validated by
  // the contract rather than here.
  if (body.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (cause) {
      flagError(
        `--assert ${body} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      flagError("--assert with JSON must be an object with at least a `kind`.");
    }
    const assertion = parsed as AssertionInput;
    return negate === undefined ? assertion : { ...assertion, negate: true };
  }

  const assertion = lower(body);
  return negate === undefined ? assertion : { ...assertion, negate: true };
};

const lower = (text: string): AssertionInput => {
  // `<name><op><value>` where the operator is `~=`, `=` or a comparison.
  const latency = /^latency\s*<\s*(.+)$/u.exec(text);
  if (latency !== null) return { kind: "latency_under_ms", expected: durationMs(latency[1] ?? "") };

  const size = /^(?:body_?bytes|bytes)\s*<\s*(\d+)$/u.exec(text);
  if (size !== null) return { kind: "body_bytes_under", expected: Number(size[1]) };

  const { at, character } = first(text, ["~=", "=", "<", ">"]);
  if (character === "=" && at !== -1) {
    const subject = text.slice(0, at);
    const value = text.slice(at + 1);
    return withSubject(subject, value, false);
  }
  if (character === "~=" && at !== -1) {
    const subject = text.slice(0, at);
    const value = text.slice(at + 2);
    return withSubject(subject, value, true);
  }
  flagError(
    `--assert ${text} is not an assertion. Use status=200, json:$.value=first, ` +
      `header:content-type=application/json, body~=substring, latency<250ms, or a JSON object.`,
  );
};

const withSubject = (subject: string, value: string, regex: boolean): AssertionInput => {
  const separator = subject.indexOf(":");
  const namespace = separator === -1 ? subject.trim() : subject.slice(0, separator).trim();
  const target = separator === -1 ? undefined : subject.slice(separator + 1).trim();

  switch (namespace) {
    case "status": {
      const code = value.trim();
      // `Number("")` is `0`, and `Number.isInteger(0)` is true, so an omitted
      // value would lower to `status_equals 0` — a code no response can carry.
      // That is not a rejected assertion but an unsatisfiable one, which fails
      // every exchange for a reason the caller never gets told.
      if (code === "") flagError("status= needs a status code or a class like 2xx.");
      const pattern = STATUS_CLASSES[code];
      if (pattern !== undefined) return { kind: "status_in", expected: [...pattern] };
      const status = Number(code);
      if (!Number.isInteger(status))
        flagError(`status=${value} is not a status code or a class like 2xx.`);
      return { kind: "status_equals", expected: status };
    }
    case "header": {
      if (target === undefined)
        flagError("A header assertion needs a header name: header:<name>=<value>.");
      return regex
        ? { kind: "header_matches", target, expected: value }
        : { kind: "header_equals", target, expected: value };
    }
    case "json": {
      if (target === undefined) flagError("A JSON assertion needs a path: json:<path>=<value>.");
      if (regex) {
        // No kind in the evaluator's vocabulary applies a regular expression to
        // a JSON path. Lowering this anyway would either drop the path and check
        // the whole body, or drop the regex and compare the literal text — and
        // in both cases the result still reads as scoped to `target`. Refusing
        // names the two checks that can be written instead.
        flagError(
          `json:${target}~= is not supported: no assertion matches a regular expression ` +
            `against a JSON path. Use json:${target}=<value> to compare the parsed value, ` +
            `or body~=<regex> to match the raw body.`,
        );
      }
      // `json:$.value` with no `=` never reaches here; the value is required by
      // this branch, and the exists form is spelled as its own subject below.
      return { kind: "body_json_path_equals", target, expected: literal(value) };
    }
    case "body":
      // The pattern belongs in `expected`, which is where `bodyMatches` reads it
      // — the same shape `header_matches` uses above. In `target` it is never
      // read, and the evaluator falls back to the empty pattern, which matches
      // every body: the check would report success whatever came back.
      return regex
        ? { kind: "body_matches", expected: value }
        : { kind: "body_contains", expected: value };
    default:
      // A bare subject with no namespace is a JSON path, which is what a caller
      // writing `--assert '$.status=ok'` means.
      if (namespace.startsWith("$")) {
        return { kind: "body_json_path_equals", target: namespace, expected: literal(value) };
      }
      flagError(
        `--assert names the subject "${namespace}", which is not one of status, header, json, body, latency, or a JSONPath starting with $.`,
      );
  }
};

/**
 * Lower an existence check, which has no `=`.
 *
 * `header:<name>` and `json:<path>` mean "is it there" — the one form that cannot
 * be written as a comparison, and the one an agent most often wants when probing
 * a response whose value it does not know yet.
 */
export const parseAssertionList = (entries: readonly string[]): readonly AssertionInput[] =>
  entries.map((entry) => {
    const text = entry.trim();
    const existence = /^(header|json):(.+)$/u.exec(text);
    if (existence !== null && !text.includes("=") && !text.includes("~=")) {
      const [, namespace, target] = existence;
      return namespace === "header"
        ? { kind: "header_exists", target: target ?? "" }
        : { kind: "body_json_path_exists", target: target ?? "" };
    }
    return parseAssertion(entry);
  });
