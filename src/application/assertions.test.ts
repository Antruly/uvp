import { describe, expect, it } from "vitest";

import { ASSERTION_KINDS, evaluateAssertions, percentile } from "./assertions.js";
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
    expect(outcomes.map((outcome) => outcome.passed)).toEqual([true, false]);
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

describe("status_equals", () => {
  it("passes when the recorded status matches the expectation", () => {
    expect(only(exchange({ status: 200 }), { kind: "status_equals", expected: 200 })).toMatchObject(
      {
        passed: true,
        observed: 200,
      },
    );
  });

  it("fails when the status differs, and reports what it saw", () => {
    const outcome = only(exchange({ status: 500 }), { kind: "status_equals", expected: 200 });
    expect(outcome.passed).toBe(false);
    expect(outcome.observed).toBe(500);
    expect(outcome.expected).toBe(200);
    expect(outcome.message).toContain("500");
  });

  it("treats an unrecorded status as a failure, not a match", () => {
    // A request that never produced a response line has no status. Comparing
    // `undefined` to `undefined` must not read as success.
    const outcome = only(exchange({ status: undefined }), {
      kind: "status_equals",
      expected: 200,
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.observed).toBeUndefined();
    expect(outcome.message).toContain("no response status");
  });

  it("compares a numeric status against its string form, as documented", () => {
    expect(only(exchange({ status: 200 }), { kind: "status_equals", expected: "200" }).passed).toBe(
      true,
    );
  });
});

describe("status_in", () => {
  it("passes when the status is one of the allowed values", () => {
    expect(
      only(exchange({ status: 204 }), { kind: "status_in", expected: [200, 204] }).passed,
    ).toBe(true);
  });

  it("fails when the status is outside the allowed set, naming the set", () => {
    const outcome = only(exchange({ status: 500 }), { kind: "status_in", expected: [200, 204] });
    expect(outcome.passed).toBe(false);
    expect(outcome.observed).toBe(500);
    expect(outcome.message).toContain("200");
    expect(outcome.message).toContain("204");
  });

  it("fails when no status was recorded, even if the set is empty", () => {
    expect(
      only(exchange({ status: undefined }), { kind: "status_in", expected: [200] }).passed,
    ).toBe(false);
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
    expect(outcome.passed).toBe(true);
    expect(outcome.observed).toBe("application/json");
  });

  it("header_equals fails and reports the observed value when it differs", () => {
    const outcome = only(withHeaders({ "content-type": "text/plain" }), {
      kind: "header_equals",
      target: "content-type",
      expected: "application/json",
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.observed).toBe("text/plain");
  });

  it("header_equals fails when the header is absent rather than matching nothing", () => {
    const outcome = only(withHeaders({}), {
      kind: "header_equals",
      target: "content-type",
      expected: "application/json",
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.observed).toBeUndefined();
    expect(outcome.message).toContain("absent");
  });

  it("header_exists passes when the header is present, whatever its value", () => {
    const outcome = only(withHeaders({ authorization: "" }), {
      kind: "header_exists",
      target: "Authorization",
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.observed).toBe("");
  });

  it("header_exists fails when the header is absent", () => {
    const outcome = only(withHeaders({}), { kind: "header_exists", target: "Authorization" });
    expect(outcome.passed).toBe(false);
    expect(outcome.observed).toBeUndefined();
  });

  it("header_matches passes when the value matches the pattern", () => {
    expect(
      only(withHeaders({ "content-type": "application/json; charset=utf-8" }), {
        kind: "header_matches",
        target: "content-type",
        expected: "^application/json",
      }).passed,
    ).toBe(true);
  });

  it("header_matches fails when the value does not match, keeping the observed value", () => {
    const outcome = only(withHeaders({ "content-type": "text/plain" }), {
      kind: "header_matches",
      target: "content-type",
      expected: "^application/json",
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.observed).toBe("text/plain");
  });

  it("header_matches reports an invalid pattern as a failure rather than throwing", () => {
    // A caller-supplied pattern is untrusted input. An exception here would abort
    // the whole assertion run, hiding the other results with it.
    const outcome = only(withHeaders({ "content-type": "text/plain" }), {
      kind: "header_matches",
      target: "content-type",
      expected: "(",
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.message).toContain("invalid regular expression");
  });

  // DEFECT (reported): `headerExists` builds its message as `header <name>
  // present` unconditionally, so a failing header_exists — which failed *because*
  // the header was absent — is surfaced by uvp_assert_exchange as the failure
  // text "header authorization present". The message must state the observation
  // it made, as header_equals does ("header content-type is absent").
  it("header_exists describes the absence it found, rather than claiming presence", () => {
    const outcome = only(withHeaders({}), { kind: "header_exists", target: "Authorization" });
    expect(outcome.passed).toBe(false);
    expect(outcome.message).toBe("header authorization is absent");
  });
});

describe("body assertions", () => {
  const withBody = (text: string): ExchangeRecord =>
    exchange({ responseBody: Buffer.from(text, "utf8") });

  it("body_contains passes when the needle is present", () => {
    expect(
      only(withBody('{"status":"healthy"}'), { kind: "body_contains", expected: "healthy" }).passed,
    ).toBe(true);
  });

  it("body_contains fails when the needle is missing", () => {
    const outcome = only(withBody('{"status":"healthy"}'), {
      kind: "body_contains",
      expected: "degraded",
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.message).toContain("degraded");
  });

  it("body_contains fails, rather than matching, when no body was recorded", () => {
    // `String(undefined)` is "undefined", so a body check against a missing body
    // must short-circuit instead of searching a string that does not exist.
    const outcome = only(exchange(), { kind: "body_contains", expected: "healthy" });
    expect(outcome.passed).toBe(false);
    expect(outcome.observed).toBeUndefined();
  });

  it("body_matches passes when the body matches the pattern", () => {
    expect(
      only(withBody("service ready"), { kind: "body_matches", expected: "^service" }).passed,
    ).toBe(true);
  });

  it("body_matches fails when the body does not match, keeping a bounded excerpt", () => {
    const outcome = only(withBody("not ready"), {
      kind: "body_matches",
      expected: "^service",
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.observed).toBe("not ready");
  });

  it("body_matches reports an invalid pattern as a failure rather than throwing", () => {
    const outcome = only(withBody("anything"), { kind: "body_matches", expected: "[" });
    expect(outcome.passed).toBe(false);
    expect(outcome.message).toContain("invalid regular expression");
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
    expect(outcome.passed).toBe(true);
    expect(outcome.observed).toBe(3);
  });

  it("body_json_path_equals fails when the value differs, reporting what it resolved", () => {
    const outcome = only(withJson({ ok: false }), {
      kind: "body_json_path_equals",
      target: "$.ok",
      expected: true,
    });
    expect(outcome.passed).toBe(false);
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
    expect(outcome.passed).toBe(false);
    expect(outcome.observed).toBeUndefined();
    expect(outcome.message).toBe("$.nope is absent, expected 1");
  });

  it("body_json_path_equals fails when the body is not JSON at all", () => {
    const outcome = only(exchange({ responseBody: Buffer.from("<html>", "utf8") }), {
      kind: "body_json_path_equals",
      target: "$.ok",
      expected: true,
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.message).toContain("not valid JSON");
  });

  it("body_json_path_exists passes for a key that resolves", () => {
    expect(
      only(withJson({ ok: true }), { kind: "body_json_path_exists", target: "$.ok" }).passed,
    ).toBe(true);
  });

  it("body_json_path_exists fails for a key that is not there", () => {
    const outcome = only(withJson({ ok: true }), {
      kind: "body_json_path_exists",
      target: "$.missing",
    });
    expect(outcome.passed).toBe(false);
  });

  it("reports a path the engine cannot evaluate as unsupported, not as a resolved nothing", () => {
    // "The path resolved to nothing" and "I cannot evaluate this path" are
    // different facts; the first is a failed assertion, the second is a limit.
    const outcome = only(withJson({ ok: true }), {
      kind: "body_json_path_exists",
      target: "ok",
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.message).toContain("unsupported JSONPath");
  });
});

describe("measurement assertions", () => {
  it("body_bytes_under passes when the recorded body is smaller than the limit", () => {
    const outcome = only(exchange({ responseBody: Buffer.alloc(4) }), {
      kind: "body_bytes_under",
      expected: 10,
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.observed).toBe(4);
  });

  it("body_bytes_under fails at or above the limit, naming both numbers", () => {
    const outcome = only(exchange({ responseBody: Buffer.alloc(4) }), {
      kind: "body_bytes_under",
      expected: 4,
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.observed).toBe(4);
    expect(outcome.message).toContain("4");
  });

  it("latency_under_ms passes when the recorded duration is under the limit", () => {
    expect(
      only(exchange({ durationMs: 5 }), { kind: "latency_under_ms", expected: 10 }).passed,
    ).toBe(true);
  });

  it("latency_under_ms fails at or above the limit, naming the observed latency", () => {
    const outcome = only(exchange({ durationMs: 120 }), {
      kind: "latency_under_ms",
      expected: 100,
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.observed).toBe(120);
    expect(outcome.message).toContain("120");
    expect(outcome.message).toContain("100");
  });
});

describe("negate", () => {
  it("inverts the verdict and says so in the message", () => {
    const outcome = only(exchange({ status: 200 }), {
      kind: "status_equals",
      expected: 200,
      negate: true,
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.message.startsWith("negated: ")).toBe(true);
  });

  it("turns a check that would have failed into a pass", () => {
    const outcome = only(exchange({ status: 200 }), {
      kind: "status_equals",
      expected: 500,
      negate: true,
    });
    expect(outcome.passed).toBe(true);
  });

  it("inverts the observed value's verdict, not the other fields", () => {
    // Negation is applied in one place, after the evaluator ran, so `observed`
    // and `expected` still describe the exchange rather than the inverted claim.
    const outcome = only(exchange({ status: 500 }), {
      kind: "status_equals",
      expected: 200,
      negate: true,
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.observed).toBe(500);
    expect(outcome.expected).toBe(200);
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
