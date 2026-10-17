import { describe, expect, it } from "vitest";

import {
  ASSERTION_KINDS,
  evaluateAssertions,
  evaluateJsonPath,
  percentile,
  requestLabel,
  unevaluatedQuestion,
} from "./assertions.js";
import type { AssertionOutcome, AssertionSpec } from "./assertions.js";
import type { ExchangeRecord } from "./sessionStore.js";

/**
 * The assertion engine turns a recorded exchange into a verdict a caller acts on.
 * Every assertion must return the value it actually observed, so a failure tells
 * the caller whether the request even completed, and a check that could not run
 * must not be reported as a value that happened to match.
 */

const baseExchange: ExchangeRecord = {
  exchangeId: "xchg_1",
  at: "2026-10-15T00:00:00.000Z",
  method: "GET",
  url: "http://127.0.0.1:8080/health",
  status: 200,
  statusText: "OK",
  httpVersion: "1.1",
  requestHeaders: {},
  responseHeaders: {},
  responseHeadersObserved: undefined,
  requestBody: undefined,
  responseBody: undefined,
  durationMs: 5,
  requestBodyTruncated: false,
  responseBodyTruncated: false,
  error: undefined,
  captureId: undefined,
};

/** A record with every field present; a test overrides only the field it is about. */
const exchange = (overrides: Partial<ExchangeRecord> = {}): ExchangeRecord =>
  Object.assign({}, baseExchange, overrides);

/** Evaluate exactly one spec and return its outcome, so a test reads as one claim. */
const only = (record: ExchangeRecord, spec: AssertionSpec): AssertionOutcome => {
  const outcomes = evaluateAssertions(record, [spec]);
  const outcome = outcomes[0];
  if (outcome === undefined) throw new Error("the engine returned no outcome for one spec");
  return outcome;
};

describe("evaluateAssertions", () => {
  it("returns one outcome per spec, in the order it was given them", () => {
    const outcomes = evaluateAssertions(exchange(), [
      { kind: "status_equals", expected: 200 },
      { kind: "status_equals", expected: 500 },
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["satisfied", "unmet"]);
  });

  it("echoes the kind, target, and expected value it was asked about", () => {
    // The outcome is read beside a spec the caller wrote; losing the target would
    // make two failing header assertions indistinguishable in a report.
    const outcome = only(exchange(), {
      kind: "header_equals",
      target: "Content-Type",
      expected: "application/json",
    });
    expect(outcome.kind).toBe("header_equals");
    expect(outcome.target).toBe("Content-Type");
    expect(outcome.expected).toBe("application/json");
  });

  it("answers every kind in the vocabulary without throwing", () => {
    // The evaluator table is keyed by AssertionKind, so a new kind is a compile
    // error — but this catches the runtime gap where a table entry is missing.
    for (const kind of ASSERTION_KINDS) {
      const outcome = only(exchange(), { kind });
      expect(outcome.kind, kind).toBe(kind);
      expect(outcome.message.length, kind).toBeGreaterThan(0);
    }
  });
});

/**
 * The walker itself, rather than the two assertions that call it.
 *
 * `evaluateJsonPath` is exported and carries the module's only statement of what
 * a path may say — `$`, `.field`, `["field"]`, `[index]` — with everything else
 * reported as unsupported. The assertions over it were the whole of its coverage,
 * and they only ever asked for `$.ok`, `$.count`, `$.missing`, and `ok`, so the
 * bracket forms and every rejection were reached by no test at all: a mutation of
 * the `[` branch, of either bracket regex, or of the `unsupported` it returns
 * changed what the engine answers and no assertion noticed.
 */
describe("evaluateJsonPath", () => {
  const document = { ok: true, items: [{ id: 7 }], "odd key": 1 };

  it("walks each form the docblock names, and the document itself for a bare $", () => {
    expect(evaluateJsonPath(document, "$")).toEqual({ found: true, value: document });
    expect(evaluateJsonPath(document, "$.ok")).toEqual({ found: true, value: true });
    expect(evaluateJsonPath(document, "$.items[0].id")).toEqual({ found: true, value: 7 });
    // A key a `.field` cannot spell is what the quoted form is for.
    expect(evaluateJsonPath(document, '$["odd key"]')).toEqual({ found: true, value: 1 });
    expect(evaluateJsonPath(document, "$['odd key']")).toEqual({ found: true, value: 1 });
    expect(evaluateJsonPath([10, 20], "$[1]")).toEqual({ found: true, value: 20 });
    // An index past the end, and a field that is not there, are walks that
    // completed: `found` is about the path, not about the value.
    expect(evaluateJsonPath([10, 20], "$[10]")).toEqual({ found: true, value: undefined });
    expect(evaluateJsonPath(document, "$.nope")).toEqual({ found: true, value: undefined });
  });

  it("resolves a path against a document that is not a record to nothing", () => {
    // The walk is over JSON, so a document that is a string, a number, a boolean,
    // an array, `null`, or absent is a document the path cannot descend into. It
    // is not a crash and it is not a value: `Array.isArray` and the record check
    // are what keep `"text".length` and a dereference of `null` out of the answer.
    for (const [label, value] of [
      ["null", null],
      ["absent", undefined],
      ["an array", [10, 20]],
      ["a string", "text"],
      ["a number", 3],
      ["a boolean", true],
    ] as const) {
      expect(evaluateJsonPath(value, "$.length"), label).toEqual({
        found: true,
        value: undefined,
      });
    }
  });

  it.each(["ok", ""])("refuses %j before walking anything", (path) => {
    // The message names the rule rather than the offending path, because there is
    // nothing else to say about a path that is not one.
    expect(evaluateJsonPath(document, path)).toEqual({
      found: false,
      value: undefined,
      unsupported: "path must start with $",
    });
  });

  /**
   * Paths the engine cannot evaluate, each reported as itself.
   *
   * The docblock's promise is that these are *reported* rather than quietly
   * resolving to nothing, so every row asserts the whole triple — `found: false`
   * is what a caller branches on, and `unsupported` is what tells them which path
   * to correct. Several rows are the shape a caller writes by mistake: an index
   * whose `[` is missing, a bracket that is closed by a bracket it did not open,
   * a quoted key with something either side of the quotes.
   *
   * The last two are the dot branch seen from the other side. Its pattern is
   * anchored at the `.` it has already read, so a dot followed by anything other
   * than a name ends the walk; without the anchor the engine would find a later
   * `.name` — the `abc` in `$.[0].abc`, the `a` in `$...a` — and answer with a
   * field the caller never named, which is a resolved value where the honest
   * answer is that the path could not be walked.
   */
  it.each([
    ["$..a", "the recursive-descent form this engine does not implement"],
    ["$a0]", "an index whose opening bracket is missing"],
    ["$[a]", "a bracket that is neither a quoted key nor a number"],
    ["$[a1]", "a bracket whose digits do not start it"],
    ["$[1a]", "a bracket whose digits do not end it"],
    ['$[x"a"]', "a quoted key with something before its quotes"],
    ['$["a"x]', "a quoted key with something after its quotes"],
    ["$[a].b", "a field after a bracket that was refused"],
    ['$["a"', "a bracket that is never closed"],
    ["$[0", "an index that is never closed"],
    ["$.[0].abc", "a dot whose next segment is a bracket rather than a name"],
    ["$...a", "an empty segment between two dots"],
  ] as const)("reports %s as a path it will not walk — %s", (path, because) => {
    expect(evaluateJsonPath(document, path), because).toEqual({
      found: false,
      value: undefined,
      unsupported: path,
    });
  });
});

describe("status_equals", () => {
  it("passes when the recorded status matches the expectation", () => {
    expect(only(exchange({ status: 200 }), { kind: "status_equals", expected: 200 })).toMatchObject(
      {
        status: "satisfied",
        observed: 200,
      },
    );
  });

  it("fails when the status differs, and reports what it saw", () => {
    const outcome = only(exchange({ status: 500 }), { kind: "status_equals", expected: 200 });
    expect(outcome.status).toBe("unmet");
    expect(outcome.observed).toBe(500);
    expect(outcome.expected).toBe(200);
    expect(outcome.message).toContain("500");
  });

  it("reports an unrecorded status as a check that could not run", () => {
    // A request that never produced a response line has no status. Comparing
    // `undefined` to `undefined` must not read as success — and reading it as a
    // *mismatch* is the same defect one step along: it reports a service that
    // answered with the wrong status when nothing answered at all.
    const outcome = only(exchange({ status: undefined }), {
      kind: "status_equals",
      expected: 200,
    });
    expect(outcome.status).toBe("undetermined");
    expect(outcome.observed).toBeUndefined();
    expect(outcome.message).toContain("no response status");
  });

  it("compares a numeric status against its string form, as documented", () => {
    expect(only(exchange({ status: 200 }), { kind: "status_equals", expected: "200" }).status).toBe(
      "satisfied",
    );
  });
});

describe("status_in", () => {
  it("passes when the status is one of the allowed values", () => {
    expect(
      only(exchange({ status: 204 }), { kind: "status_in", expected: [200, 204] }).status,
    ).toBe("satisfied");
  });

  it("fails when the status is outside the allowed set, naming the set", () => {
    const outcome = only(exchange({ status: 500 }), { kind: "status_in", expected: [200, 204] });
    expect(outcome.status).toBe("unmet");
    expect(outcome.observed).toBe(500);
    // The set as a caller reads it back. `[200204]` names no member, and the
    // membership text is the only place a failure says what it was testing.
    expect(outcome.message).toBe("status 500, expected one of [200, 204]");
  });

  it("treats an expectation that is not a set as the empty set", () => {
    // `expected` is `unknown` in the contract, so a scalar is a spec a caller can
    // send. Reading `200` as the set it is not — or as the set `[200]` it also is
    // not — would make this the one assertion that answers a question it was
    // never asked. The empty set matches nothing, which is the failure it is.
    const outcome = only(exchange({ status: 204 }), { kind: "status_in", expected: 204 });
    expect(outcome.status).toBe("unmet");
    expect(outcome.message).toBe("status 204, expected one of []");
  });

  it("does not test membership when no status was recorded", () => {
    const outcome = only(exchange({ status: undefined }), { kind: "status_in", expected: [200] });
    expect(outcome.status).toBe("undetermined");
    // The set is still named, so a reader of the verdict knows what the check
    // would have been.
    expect(outcome.message).toContain("200");
  });
});

describe("header assertions", () => {
  const withHeaders = (headers: Record<string, string>): ExchangeRecord =>
    exchange({ responseHeaders: headers });

  it("header_equals passes on an exact match, lower-casing the target it looks up", () => {
    const outcome = only(withHeaders({ "content-type": "application/json" }), {
      kind: "header_equals",
      target: "Content-Type",
      expected: "application/json",
    });
    expect(outcome.status).toBe("satisfied");
    expect(outcome.observed).toBe("application/json");
  });

  it("header_equals fails and reports the observed value when it differs", () => {
    const outcome = only(withHeaders({ "content-type": "text/plain" }), {
      kind: "header_equals",
      target: "content-type",
      expected: "application/json",
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.observed).toBe("text/plain");
  });

  it("header_equals names the header and the value it found", () => {
    // A caller reads the message when it did not match, and `header_equals` is
    // the only assertion whose observed value is not obvious from the name of the
    // header it names — so both halves are in the text.
    const outcome = only(withHeaders({ "content-type": "text/plain" }), {
      kind: "header_equals",
      target: "content-type",
      expected: "text/plain",
    });
    expect(outcome.status).toBe("satisfied");
    expect(outcome.message).toBe("header content-type=text/plain");
  });

  it("header_equals fails when the header is absent rather than matching nothing", () => {
    const outcome = only(withHeaders({}), {
      kind: "header_equals",
      target: "content-type",
      expected: "application/json",
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.observed).toBeUndefined();
    expect(outcome.message).toContain("absent");
  });

  it("header_exists passes when the header is present, whatever its value", () => {
    const outcome = only(withHeaders({ authorization: "" }), {
      kind: "header_exists",
      target: "Authorization",
    });
    expect(outcome.status).toBe("satisfied");
    expect(outcome.observed).toBe("");
  });

  it("header_exists fails when the header is absent", () => {
    const outcome = only(withHeaders({}), { kind: "header_exists", target: "Authorization" });
    expect(outcome.status).toBe("unmet");
    expect(outcome.observed).toBeUndefined();
  });

  it("header_matches passes when the value matches the pattern", () => {
    expect(
      only(withHeaders({ "content-type": "application/json; charset=utf-8" }), {
        kind: "header_matches",
        target: "content-type",
        expected: "^application/json",
      }).status,
    ).toBe("satisfied");
  });

  it("header_matches fails when the value does not match, keeping the observed value", () => {
    const outcome = only(withHeaders({ "content-type": "text/plain" }), {
      kind: "header_matches",
      target: "content-type",
      expected: "^application/json",
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.observed).toBe("text/plain");
  });

  it("header_matches fails on a header the peer left out of the response", () => {
    // The same two facts as `header_equals`, and the same reading of them: the
    // name was looked for, the peer did not send it, and that is a failure of
    // this assertion rather than a pattern nothing matched.
    const outcome = only(withHeaders({}), {
      kind: "header_matches",
      target: "content-type",
      expected: "^application/json",
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.observed).toBeUndefined();
    expect(outcome.message).toBe("header content-type is absent");
  });

  it("header_matches names the pattern it compared against", () => {
    const outcome = only(withHeaders({ "content-type": "text/plain" }), {
      kind: "header_matches",
      target: "content-type",
      expected: "^application/json",
    });
    expect(outcome.message).toBe("header content-type=text/plain, expected /^application/json/");
  });

  it("header_matches reports an invalid pattern as unevaluated rather than throwing", () => {
    // A caller-supplied pattern is untrusted input. An exception here would abort
    // the whole assertion run, hiding the other results with it — and a failure
    // would hide it differently: "the header did not match" is a statement about
    // a comparison that never ran.
    const outcome = only(withHeaders({ "content-type": "text/plain" }), {
      kind: "header_matches",
      target: "content-type",
      expected: "(",
    });
    expect(outcome.status).toBe("undetermined");
    expect(outcome.message).toContain("invalid regular expression");
  });

  // DEFECT (reported): `headerExists` builds its message as `header <name>
  // present` unconditionally, so a failing header_exists — which failed *because*
  // the header was absent — is surfaced by uvp_assert_exchange as the failure
  // text "header authorization present". The message must state the observation
  // it made, as header_equals does ("header content-type is absent").
  it("header_exists describes the absence it found, rather than claiming presence", () => {
    const outcome = only(withHeaders({}), { kind: "header_exists", target: "Authorization" });
    expect(outcome.status).toBe("unmet");
    expect(outcome.message).toBe("header authorization is absent");
  });

  it("header_exists describes the presence it found, whatever the value was", () => {
    // The other outcome of the same choice. A message built without reading it
    // back reports a pass as "is absent" and a failure as "is present", which is
    // the defect the test above names, one direction over.
    const outcome = only(withHeaders({ authorization: "Bearer token" }), {
      kind: "header_exists",
      target: "Authorization",
    });
    expect(outcome.status).toBe("satisfied");
    expect(outcome.observed).toBe("Bearer token");
    expect(outcome.message).toBe("header authorization is present");
  });

  it("looks up the empty name when a header assertion names no target", () => {
    // `target` is optional in the contract, so a spec without one is reachable.
    // What it looks up is then the empty string — a name that is not in the
    // response — rather than a word the engine invents for the occasion. The
    // message reads with the gap in it because the name really is empty.
    const outcome = only(withHeaders({ "content-type": "text/plain" }), {
      kind: "header_equals",
      expected: "text/plain",
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.message).toBe("header  is absent");
  });
});

/**
 * The third state applied to headers, and the reason it is not a nicety.
 *
 * An exchange recorded over HTTP/3 by the native probe carries only the response
 * headers the probe asked for by name — the libuvcpp C ABI reads one header at a
 * time and has no call that lists them. So for those records, "absent from
 * `responseHeaders`" has two possible causes, and only one of them is a fact about
 * the service. Reporting the other as an absence is a finding about a service
 * derived from a gap in the client, which is the failure `responseHeadersObserved`
 * exists to prevent.
 *
 * A describe of its own rather than a group inside the one above, because it is
 * the behaviour of a different kind of record: the ones above carry a complete
 * header set.
 */
describe("a record whose header set is narrower than the response", () => {
  /** A record from a client that read exactly these names and no others. */
  const narrowed = (headers: Record<string, string>, lookedAt: readonly string[]) =>
    exchange({ responseHeaders: headers, responseHeadersObserved: lookedAt });

  it.each([
    ["header_equals", { kind: "header_equals", target: "x-request-id", expected: "abc" }],
    ["header_exists", { kind: "header_exists", target: "x-request-id" }],
    ["header_matches", { kind: "header_matches", target: "x-request-id", expected: "^a" }],
  ] as const)("%s names the gap rather than the service", (kind, spec) => {
    const outcome = only(narrowed({}, ["content-type", "date"]), spec as AssertionSpec);
    expect(outcome.status, kind).toBe("undetermined");
    expect(outcome.message, kind).toContain("was not looked at");
    // Both halves matter: what happened, and which names a caller *can* assert
    // on — otherwise the next question has no answer in the report. The names
    // are a list because that is what they are; run together they name nothing.
    expect(outcome.message).toContain(
      "read only `content-type`, `date`, and a name outside that list",
    );
    expect(outcome.message).not.toContain("is absent");
  });

  it("still reports an absence for a name that was looked at", () => {
    // The control. If `responseHeadersObserved` were read as "the response had
    // exactly these headers and no others", a header the peer genuinely left
    // out would stop being reportable at all.
    const outcome = only(narrowed({ date: "now" }, ["content-type", "date"]), {
      kind: "header_exists",
      target: "content-type",
    });
    expect(outcome.message).toBe("header content-type is absent");
  });

  it("evaluates a name that was looked at normally", () => {
    const outcome = only(narrowed({ "content-type": "text/plain" }, ["content-type"]), {
      kind: "header_equals",
      target: "Content-Type",
      expected: "text/plain",
    });
    expect(outcome.status).toBe("satisfied");
    expect(outcome.observed).toBe("text/plain");
  });

  it("distinguishes a name nobody looked at from one the peer left out", () => {
    // Both come back with `observed: undefined`, and the whole point of the
    // field is that they are different facts: the first is a gap in the
    // client, the second is a fact about the response.
    const unread = only(narrowed({}, ["content-type"]), {
      kind: "header_exists",
      target: "x-request-id",
    });
    const absent = only(narrowed({}, ["content-type"]), {
      kind: "header_exists",
      target: "content-type",
    });
    expect([unread.status, absent.status]).toEqual(["undetermined", "unmet"]);
    expect(unread.message).not.toBe(absent.message);
  });

  it("does not negate a name nobody looked at into a pass", () => {
    // `!header:…` against a name outside the client's list used to pass: the
    // check never ran, `passed` was false, and negation turned that false into
    // a true — the strongest claim in the vocabulary resting on nothing.
    const outcome = only(narrowed({}, ["content-type"]), {
      kind: "header_exists",
      target: "x-request-id",
      negate: true,
    });
    expect(outcome.status).toBe("undetermined");
    expect(outcome.message.startsWith("negated: ")).toBe(true);
  });

  it("treats an absent list as the whole response, which is what the other paths read", () => {
    // `undefined` means "all of them", so the HTTP/1.1 and HTTP/2 paths — which
    // hand Node's parser a complete header set — keep the two-state behaviour
    // they had before this field existed.
    const outcome = only(exchange({ responseHeaders: { date: "now" } }), {
      kind: "header_exists",
      target: "content-type",
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.message).toBe("header content-type is absent");
  });
});

describe("body assertions", () => {
  const withBody = (text: string): ExchangeRecord =>
    exchange({ responseBody: Buffer.from(text, "utf8") });

  it("body_contains passes when the needle is present", () => {
    expect(
      only(withBody('{"status":"healthy"}'), { kind: "body_contains", expected: "healthy" }).status,
    ).toBe("satisfied");
  });

  it("body_contains fails when the needle is missing", () => {
    const outcome = only(withBody('{"status":"healthy"}'), {
      kind: "body_contains",
      expected: "degraded",
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.message).toContain("degraded");
  });

  it("body_contains reports a missing body instead of a length for it", () => {
    // `String(undefined)` is "undefined", so a body check against a missing body
    // must short-circuit instead of searching a string that does not exist. The
    // message used to read `body length 0` — a length for a body nobody
    // recorded, and the number that made `body_bytes_under` pass.
    const outcome = only(exchange(), { kind: "body_contains", expected: "healthy" });
    expect(outcome.status).toBe("undetermined");
    expect(outcome.observed).toBeUndefined();
    expect(outcome.message).toContain("no response body was recorded");
    expect(outcome.message).not.toContain("length 0");
  });

  it("body_matches passes when the body matches the pattern", () => {
    expect(
      only(withBody("service ready"), { kind: "body_matches", expected: "^service" }).status,
    ).toBe("satisfied");
  });

  it("body_matches fails when the body does not match, keeping a bounded excerpt", () => {
    const outcome = only(withBody("not ready"), {
      kind: "body_matches",
      expected: "^service",
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.observed).toBe("not ready");
  });

  it("body_matches reports an invalid pattern as unevaluated rather than throwing", () => {
    const outcome = only(withBody("anything"), { kind: "body_matches", expected: "[" });
    expect(outcome.status).toBe("undetermined");
    expect(outcome.message).toContain("invalid regular expression");
  });

  it("compiles a caller's pattern in unicode mode", () => {
    // The module compiles every caller pattern with the `u` flag, and a Unicode
    // property escape is the difference that shows: without it `\p{Lu}` is a `p`,
    // a literal `{Lu}`, and a quantifier that is not one, so a body of capitals
    // stops matching the pattern that names capitals.
    expect(only(withBody("HELLO"), { kind: "body_matches", expected: "^\\p{Lu}+$" }).status).toBe(
      "satisfied",
    );
  });

  it("keeps a bounded excerpt of the body rather than the whole of it", () => {
    // A response body is the one thing in a record with no bound of its own, and
    // an assertion's observed value travels into a report. `body_bytes_under`
    // measures the size; nothing measures the excerpt, so this pins it.
    const outcome = only(withBody("x".repeat(600)), { kind: "body_contains", expected: "x" });
    expect(outcome.status).toBe("satisfied");
    expect(String(outcome.observed)).toHaveLength(512);
    expect(outcome.message).toBe('body length 600, expected to contain "x"');
  });

  it("keeps the same bounded excerpt for a match, and names the length it read", () => {
    const body = `service ${"x".repeat(600)}`;
    const outcome = only(withBody(body), { kind: "body_matches", expected: "^service" });
    expect(outcome.status).toBe("satisfied");
    expect(String(outcome.observed)).toHaveLength(512);
    expect(outcome.message).toBe("body length 608, expected to match /^service/");
  });

  it("keeps the bounded excerpt when the pattern does not compile", () => {
    // The unevaluated branch hands the observed value to the caller like every
    // other, and it is the branch a long body is most likely to reach: the
    // pattern is checked before the body is.
    const outcome = only(withBody("x".repeat(600)), { kind: "body_matches", expected: "[" });
    expect(outcome.status).toBe("undetermined");
    expect(String(outcome.observed)).toHaveLength(512);
  });
});

describe("JSON path assertions", () => {
  const withJson = (value: unknown): ExchangeRecord =>
    exchange({ responseBody: Buffer.from(JSON.stringify(value), "utf8") });

  it("body_json_path_equals passes when the resolved value equals the expectation", () => {
    const outcome = only(withJson({ ok: true, count: 3 }), {
      kind: "body_json_path_equals",
      target: "$.count",
      expected: 3,
    });
    expect(outcome.status).toBe("satisfied");
    expect(outcome.observed).toBe(3);
  });

  it("body_json_path_equals fails when the value differs, reporting what it resolved", () => {
    const outcome = only(withJson({ ok: false }), {
      kind: "body_json_path_equals",
      target: "$.ok",
      expected: true,
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.observed).toBe(false);
    // Both halves, because in a verification bundle this string is all a caller
    // is given: the expectation is not carried anywhere else in the output.
    expect(outcome.message).toBe("$.ok = false, expected true");
  });

  it("says a missing path is absent rather than resolving to a value", () => {
    // `JSON.stringify(undefined)` is `undefined`, so the message used to read
    // `$.nope = undefined` — a value the body might plausibly have held, when
    // the fact is that the path is not there at all.
    const outcome = only(withJson({ ok: true }), {
      kind: "body_json_path_equals",
      target: "$.nope",
      expected: 1,
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.observed).toBeUndefined();
    expect(outcome.message).toBe("$.nope is absent, expected 1");
  });

  it("body_json_path_equals reports a body that is not JSON as unevaluated", () => {
    const outcome = only(exchange({ responseBody: Buffer.from("<html>", "utf8") }), {
      kind: "body_json_path_equals",
      target: "$.ok",
      expected: true,
    });
    expect(outcome.status).toBe("undetermined");
    expect(outcome.message).toContain("not valid JSON");
  });

  it("separates a body that is not JSON from one that was never recorded", () => {
    // "response body is not valid JSON" about a body nobody recorded is a claim
    // about content that does not exist, and it sends the caller looking for a
    // serialization bug instead of a response that never arrived.
    const outcome = only(exchange({ responseBody: undefined }), {
      kind: "body_json_path_equals",
      target: "$.ok",
      expected: true,
    });
    expect(outcome.status).toBe("undetermined");
    expect(outcome.message).toContain("no response body was recorded");
  });

  it("treats an empty body as absent rather than as invalid JSON", () => {
    const outcome = only(exchange({ responseBody: Buffer.alloc(0) }), {
      kind: "body_json_path_exists",
      target: "$.ok",
    });
    expect(outcome.status).toBe("undetermined");
    expect(outcome.message).toContain("no response body was recorded");
  });

  it("body_json_path_exists passes for a key that resolves", () => {
    expect(
      only(withJson({ ok: true }), { kind: "body_json_path_exists", target: "$.ok" }).status,
    ).toBe("satisfied");
  });

  it("body_json_path_exists fails for a key that is not there", () => {
    const outcome = only(withJson({ ok: true }), {
      kind: "body_json_path_exists",
      target: "$.missing",
    });
    expect(outcome.status).toBe("unmet");
  });

  it("reports a path the engine cannot evaluate as unsupported, not as a resolved nothing", () => {
    // "The path resolved to nothing" and "I cannot evaluate this path" are
    // different facts; the first is a failed assertion, the second is a limit.
    const outcome = only(withJson({ ok: true }), {
      kind: "body_json_path_exists",
      target: "ok",
    });
    expect(outcome.status).toBe("undetermined");
    expect(outcome.message).toContain("unsupported JSONPath");
  });

  it("reads the whole document when the assertion names no path", () => {
    // `target` is optional in the contract, and the default is `$` — the document
    // the body parsed to — rather than an empty path, which the walker would have
    // to refuse. An assertion about the body as a whole is a real question.
    const outcome = only(withJson({ ok: true }), { kind: "body_json_path_exists" });
    expect(outcome.status).toBe("satisfied");
    expect(outcome.observed).toEqual({ ok: true });
  });

  it("names the value it resolved for a path that is there", () => {
    const outcome = only(withJson({ ok: true }), {
      kind: "body_json_path_exists",
      target: "$.ok",
    });
    expect(outcome.message).toBe("$.ok = true");
  });

  it("says a path is absent rather than reporting the value undefined", () => {
    // `JSON.stringify(undefined)` is not a string, so a message built from the
    // value reads `$.missing = undefined` — a value the body might have held,
    // where the fact is that the key is not there.
    const outcome = only(withJson({ ok: true }), {
      kind: "body_json_path_exists",
      target: "$.missing",
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.observed).toBeUndefined();
    expect(outcome.message).toBe("$.missing is absent");
  });

  it("compares a number the body spells as a string against a numeric expectation", () => {
    // The loose comparison the docblock of `looseEquals` names: `"3"` satisfies
    // `3`, because a service that sends a count as a string sent the count. The
    // guard that carries it is about the *observed* side being a number; read the
    // other way round it makes this the assertion that never matches.
    const outcome = only(withJson({ count: "3" }), {
      kind: "body_json_path_equals",
      target: "$.count",
      expected: 3,
    });
    expect(outcome.status).toBe("satisfied");
    expect(outcome.observed).toBe("3");
  });

  it("does not read a JSON null as the string that spells it", () => {
    // Loose between a number and its spelling, and nothing else: `null` is a
    // value the body held, `"null"` is a string, and a service that stopped
    // sending the key must not satisfy an assertion on the string.
    const outcome = only(withJson({ ok: null }), {
      kind: "body_json_path_equals",
      target: "$.ok",
      expected: "null",
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.message).toBe('$.ok = null, expected "null"');
  });

  it("does not read an absent path as the string that spells it", () => {
    const outcome = only(withJson({ ok: true }), {
      kind: "body_json_path_equals",
      target: "$.nope",
      expected: "undefined",
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.message).toBe('$.nope is absent, expected "undefined"');
  });

  it("says an assertion with no expectation is one whose expectation is absent", () => {
    // `expected` is optional in the contract, so this is a spec a caller can
    // send, and the message has the same rule as the path beside it: `undefined`
    // is not a JSON word, and `expected undefined` reads as a value the caller
    // wrote rather than as nothing written at all.
    const outcome = only(withJson({ ok: true }), {
      kind: "body_json_path_equals",
      target: "$.ok",
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.message).toBe("$.ok = true, expected absent");
  });
});

describe("measurement assertions", () => {
  it("body_bytes_under passes when the recorded body is smaller than the limit", () => {
    const outcome = only(exchange({ responseBody: Buffer.alloc(4) }), {
      kind: "body_bytes_under",
      expected: 10,
    });
    expect(outcome.status).toBe("satisfied");
    expect(outcome.observed).toBe(4);
  });

  it("body_bytes_under fails at or above the limit, naming both numbers", () => {
    const outcome = only(exchange({ responseBody: Buffer.alloc(4) }), {
      kind: "body_bytes_under",
      expected: 4,
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.observed).toBe(4);
    expect(outcome.message).toContain("4");
  });

  it("does not measure the size of a body nobody recorded", () => {
    // `record.responseBody?.byteLength ?? 0` read an absent body as zero bytes,
    // and zero is under every positive limit: this assertion passed on an
    // exchange whose request never completed. The size of a body that is not
    // there is not a number, so no limit can be compared against it.
    const outcome = only(exchange({ responseBody: undefined }), {
      kind: "body_bytes_under",
      expected: 10,
    });
    expect(outcome.status).toBe("undetermined");
    expect(outcome.observed).toBeUndefined();
    expect(outcome.message).toContain("no response body was recorded");
  });

  it("does not compare a failed request's duration to a latency limit", () => {
    // A record with no status is a request that never got a response line; the
    // duration it carries is the time until it failed. Comparing that to a
    // latency limit reports a connection failure as a fast service.
    const outcome = only(exchange({ status: undefined, durationMs: 3 }), {
      kind: "latency_under_ms",
      expected: 100,
    });
    expect(outcome.status).toBe("undetermined");
    expect(outcome.message).toContain("no response was recorded");
  });

  it("latency_under_ms passes when the recorded duration is under the limit", () => {
    const outcome = only(exchange({ durationMs: 5 }), { kind: "latency_under_ms", expected: 10 });
    expect(outcome.status).toBe("satisfied");
  });

  it("latency_under_ms fails at or above the limit, naming the observed latency", () => {
    const above = only(exchange({ durationMs: 120 }), {
      kind: "latency_under_ms",
      expected: 100,
    });
    expect(above.status).toBe("unmet");
    expect(above.observed).toBe(120);
    expect(above.message).toBe("latency 120 ms, limit 100");
    // The limit itself, which `body_bytes_under` is already held to: "under
    // 100 ms" is not satisfied by 100 ms, and a limit read as inclusive is a
    // budget a caller cannot state.
    const at = only(exchange({ durationMs: 100 }), {
      kind: "latency_under_ms",
      expected: 100,
    });
    expect(at.status).toBe("unmet");
    expect(at.message).toBe("latency 100 ms, limit 100");
  });
});

describe("http_version_equals", () => {
  it("passes when the response arrived in the version asked for", () => {
    const outcome = only(exchange({ httpVersion: "2.0" }), {
      kind: "http_version_equals",
      expected: "2.0",
    });
    expect(outcome.status).toBe("satisfied");
    expect(outcome.observed).toBe("2.0");
  });

  it("fails when the service answered in another version, naming both", () => {
    // The whole reason this kind exists: a service that serves HTTP/1.1 whatever
    // it is sent must not satisfy a claim about HTTP/2. Every other kind in the
    // vocabulary passes here — the response is a 200 with the right body.
    const outcome = only(exchange({ status: 200, httpVersion: "1.1" }), {
      kind: "http_version_equals",
      expected: "2.0",
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.observed).toBe("1.1");
    expect(outcome.message).toContain("1.1");
    expect(outcome.message).toContain("2.0");
  });

  it("does not treat the requested spelling as the observed one", () => {
    // `uvp_http_request` takes `http_version: "2"` — the version to *attempt* —
    // and reports `http_version: "2.0"` — what was negotiated. If the assertion
    // compared loosely, `http_version=2` would pass against a service that spoke
    // HTTP/2 and also against one that spoke HTTP/1.1, which is no check at all.
    const outcome = only(exchange({ httpVersion: "2.0" }), {
      kind: "http_version_equals",
      expected: "2",
    });
    expect(outcome.status).toBe("unmet");
  });

  it("reports that nothing negotiated anything when no response was recorded", () => {
    const outcome = only(exchange({ httpVersion: undefined }), {
      kind: "http_version_equals",
      expected: "2.0",
    });
    expect(outcome.status).toBe("undetermined");
    expect(outcome.observed).toBeUndefined();
    expect(outcome.message).toContain("no http version was recorded");
  });

  it("is satisfied by a service that spoke HTTP/2 and also by asserting the absence of it", () => {
    // Both directions pinned, so the kind cannot be one that accepts everything.
    const spokeH2 = exchange({ httpVersion: "2.0" });
    expect(only(spokeH2, { kind: "http_version_equals", expected: "2.0" }).status).toBe(
      "satisfied",
    );
    expect(only(spokeH2, { kind: "http_version_equals", expected: "1.1" }).status).toBe("unmet");
  });
});

describe("negate", () => {
  it("inverts the verdict and says so in the message", () => {
    const outcome = only(exchange({ status: 200 }), {
      kind: "status_equals",
      expected: 200,
      negate: true,
    });
    expect(outcome.status).toBe("unmet");
    expect(outcome.message.startsWith("negated: ")).toBe(true);
  });

  it("turns a check that would have failed into a pass", () => {
    const outcome = only(exchange({ status: 200 }), {
      kind: "status_equals",
      expected: 500,
      negate: true,
    });
    expect(outcome.status).toBe("satisfied");
  });

  it("inverts the observed value's verdict, not the other fields", () => {
    // Negation is applied in one place, after the evaluator ran, so `observed`
    // and `expected` still describe the exchange rather than the inverted claim.
    const outcome = only(exchange({ status: 500 }), {
      kind: "status_equals",
      expected: 200,
      negate: true,
    });
    expect(outcome.status).toBe("satisfied");
    expect(outcome.observed).toBe(500);
    expect(outcome.expected).toBe(200);
  });

  it("does not manufacture a pass out of a check that never ran", () => {
    // The one place where the third state was dangerous. A check that could not
    // be evaluated used to carry `passed: false`, `!false` is `true`, and so a
    // negated assertion over an exchange the engine could not read reported a
    // pass — the strongest claim in the vocabulary resting on a request that
    // never completed. Negation inverts a verdict; there was no verdict here,
    // and `negateVerdict` is what keeps it that way.
    const outcome = only(exchange({ status: undefined }), {
      kind: "status_equals",
      expected: 200,
      negate: true,
    });
    expect(outcome.status).toBe("undetermined");
    expect(outcome.message.startsWith("negated: ")).toBe(true);
  });
});

describe("status", () => {
  it("is satisfied for every kind on a record that carries every fact they need", () => {
    // The control for the third state: if an evaluator's guard were widened,
    // every assertion would quietly become "could not run" and the counts
    // would read as clean. This pins the other end.
    const complete = exchange({
      status: 200,
      httpVersion: "1.1",
      responseHeaders: { "content-type": "application/json", "x-request-id": "abc" },
      responseBody: Buffer.from('{"ok":true}', "utf8"),
      durationMs: 5,
    });
    for (const kind of ASSERTION_KINDS) {
      expect(only(complete, { kind, target: "$.ok", expected: 1 }).status, kind).not.toBe(
        "undetermined",
      );
    }
  });

  it("is decided per assertion, not per exchange", () => {
    // One exchange can answer one question and not another, and a single flag
    // for the record would collapse the two into one verdict.
    const outcomes = evaluateAssertions(exchange({ responseBody: undefined }), [
      { kind: "status_equals", expected: 200 },
      { kind: "body_bytes_under", expected: 10 },
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["satisfied", "undetermined"]);
  });
});

/**
 * The question a check that could not run leaves behind.
 *
 * This is the line a reader of a verification bundle sees first, and it is built
 * out of the caller's own assertion — so it is only as good as the three parts it
 * is assembled from, and the parts are optional. What it must never be is a
 * sentence that names the check twice or not at all.
 */
describe("unevaluatedQuestion", () => {
  it("names the kind, the target, the expectation, and the exchange it was asked of", () => {
    expect(
      unevaluatedQuestion({ kind: "header_exists", target: "x-request-id" }, "for GET /items/1"),
    ).toBe("Does `header_exists` on `x-request-id` hold for GET /items/1?");
  });

  it("leaves out the parts the assertion did not carry", () => {
    // `target` and `expected` are optional, and an absent one is not a part of
    // the question: "on `undefined`" names a target nobody asked for.
    expect(unevaluatedQuestion({ kind: "status_equals" }, "for GET /items/1")).toBe(
      "Does `status_equals` hold for GET /items/1?",
    );
    expect(unevaluatedQuestion({ kind: "body_json_path_exists", target: "$.ok" }, "for it")).toBe(
      "Does `body_json_path_exists` on `$.ok` hold for it?",
    );
  });

  it("renders the expectation as JSON, which is what the caller wrote", () => {
    expect(
      unevaluatedQuestion(
        { kind: "body_json_path_equals", target: "$.ok", expected: { ok: true } },
        "for POST /items",
      ),
    ).toBe('Does `body_json_path_equals` on `$.ok` ({"ok":true}) hold for POST /items?');
  });

  it("caps an expectation that would not fit in a question", () => {
    // A document is a legal expectation and a question is a line. The number is
    // in the message either way, and the ellipsis says the rest was left out.
    const written = JSON.stringify("x".repeat(200));
    const question = unevaluatedQuestion(
      { kind: "body_contains", expected: "x".repeat(200) },
      "for GET /items",
    );
    expect(question).toBe(`Does \`body_contains\` (${written.slice(0, 80)}…) hold for GET /items?`);
    // The cap as a reader of the document sees it, rather than as the slice that
    // implements it: no run of it longer than the cap reaches the question.
    expect(question).not.toContain("x".repeat(81));
  });

  it("does not cap an expectation of exactly the cap", () => {
    // `JSON.stringify` of a 78-character string is 80 characters with its
    // quotes, and 80 is a question that fits. The boundary is the difference
    // between "shorter than the cap" and "within it".
    const capped = JSON.stringify("x".repeat(78));
    expect(capped).toHaveLength(80);
    expect(
      unevaluatedQuestion({ kind: "body_contains", expected: "x".repeat(78) }, "for GET /items"),
    ).toBe(`Does \`body_contains\` (${capped}) hold for GET /items?`);
  });
});

describe("requestLabel", () => {
  it("names a request once when its name is already its method and path", () => {
    // What `uvp verify` builds, and what a captured bundle showed reaching a
    // reader as "hold for GET /items/1 (GET /items/1)?" — the same request named
    // twice in one sentence.
    expect(requestLabel({ name: "GET /items/1", method: "GET", path: "/items/1" })).toBe(
      "GET /items/1",
    );
    expect(requestLabel({ name: "POST /items", method: "POST", path: "/items" })).toBe(
      "POST /items",
    );
  });

  it("adds the method and path when the name is a caller's own", () => {
    // An `uvp_verify` caller names a request, and the name alone may not say
    // which request it was — so the method and path are added in parentheses
    // rather than dropped.
    expect(requestLabel({ name: "first-item", method: "GET", path: "/items/1" })).toBe(
      "first-item (GET /items/1)",
    );
  });

  it("adds them when the name repeats only part of the method and path", () => {
    // The comparison is against the whole label, not a substring of it: a name
    // that merely mentions the path still needs the method to identify it.
    expect(requestLabel({ name: "/items/1", method: "GET", path: "/items/1" })).toBe(
      "/items/1 (GET /items/1)",
    );
    expect(requestLabel({ name: "GET items/1", method: "GET", path: "/items/1" })).toBe(
      "GET items/1 (GET /items/1)",
    );
  });
});

describe("percentile", () => {
  it("is defined on an empty sample list, returning zero", () => {
    // A run with no successful requests must still produce a number the caller
    // can render, rather than `undefined` reaching the latency report.
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([], 0.99)).toBe(0);
  });

  it("uses nearest-rank over a sorted sample", () => {
    // Nearest-rank never interpolates: every reported value is one the run
    // actually observed. A p95 is therefore a real latency, not a synthetic
    // midpoint between two of them.
    const samples = [10, 20, 30, 40];
    expect(percentile(samples, 0.5)).toBe(20);
    expect(percentile(samples, 0.75)).toBe(30);
    expect(percentile(samples, 1)).toBe(40);
  });

  it("reads the same sample the caller sorted, so unsorted input is the caller's error", () => {
    // Documented contract: the argument is already sorted. This pins the reading
    // so a future "sort it for them" change is a deliberate one.
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });

  it("clamps a fraction outside [0, 1] to the ends of the sample", () => {
    const samples = [10, 20, 30];
    expect(percentile(samples, 0)).toBe(10);
    expect(percentile(samples, -1)).toBe(10);
    expect(percentile(samples, 1.5)).toBe(30);
  });
});
