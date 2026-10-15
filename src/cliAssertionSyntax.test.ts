import { describe, expect, it } from "vitest";

import { parseAssertion, parseAssertionList } from "./cli/assertionSyntax.js";
import { isUvpFailure } from "./domain/errors.js";

/**
 * The `--assert` mini-language is a lowering, not a second evaluator.
 *
 * Every form here has to land on an assertion object the shared evaluator
 * (src/application/assertions.ts) already understands, because a CLI assertion
 * and an MCP assertion that look the same have to *be* the same check. The risk
 * this file guards is a form that looks expressible, parses without complaint,
 * and means something weaker than what the user typed.
 */

/** The message a rejected form reports; a bare `Error` would be a crash, not usage. */
const rejection = (text: string): string => {
  try {
    parseAssertion(text);
  } catch (cause) {
    if (!isUvpFailure(cause)) throw cause;
    return cause.detail.message;
  }
  throw new Error(`--assert ${JSON.stringify(text)} was expected to be rejected`);
};

describe("parseAssertion: status", () => {
  it("lowers status=200 to a status equality", () => {
    expect(parseAssertion("status=200")).toEqual({ kind: "status_equals", expected: 200 });
  });

  it("lowers a class like 2xx to its members rather than to a range", () => {
    // A range would silently widen: `status=2xx` has to admit exactly the codes
    // the vocabulary names, so a status the list does not carry fails the
    // assertion instead of passing it.
    const { kind, expected } = parseAssertion("status=2xx");
    expect(kind).toBe("status_in");
    if (!Array.isArray(expected)) throw new Error("status_in needs a list of codes");
    expect(expected).toContain(200);
    expect(expected).toContain(204);
    expect(expected.every((code) => code >= 200 && code < 300)).toBe(true);
  });

  it("rejects a status that is neither a code nor a class, naming what it saw", () => {
    expect(rejection("status=6xx")).toContain("6xx");
    expect(rejection("status=abc")).toContain("abc");
  });

  it("rejects an empty status rather than reading it as zero", () => {
    // `Number("")` is 0 and `Number.isInteger(0)` is true, so the is-integer
    // guard alone accepts an omitted value and lowers it to `status_equals 0`.
    // That is not a rejected assertion but an unsatisfiable one: no response
    // carries status 0, so every exchange fails for a reason the caller is never
    // told. Rejecting says what went wrong.
    expect(rejection("status=")).toContain("status");
    expect(rejection("status= ")).toContain("status");
  });
});

describe("parseAssertion: json and body", () => {
  it("lowers json:<path>=<value> and parses the value as JSON", () => {
    // The comparison happens after parsing, so `json:$.count=5` has to arrive as
    // the number 5: comparing the text "5" against a parsed number would fail
    // for the JSON body the caller actually has.
    expect(parseAssertion("json:$.value=first")).toEqual({
      kind: "body_json_path_equals",
      target: "$.value",
      expected: "first",
    });
    expect(parseAssertion("json:$.count=5").expected).toBe(5);
    expect(parseAssertion("json:$.flag=true").expected).toBe(true);
    expect(parseAssertion('json:$.name="q"').expected).toBe("q");
  });

  it("lowers a bare JSONPath, which is what `--assert '$.status=ok'` means", () => {
    expect(parseAssertion("$.status=ok")).toEqual({
      kind: "body_json_path_equals",
      target: "$.status",
      expected: "ok",
    });
  });

  it("lowers header:<name>=<value> to a text comparison, not a parsed one", () => {
    // A header value is text. `header:x-count=5` must compare against the string
    // "5", so it must not be JSON-parsed the way a `json:` value is.
    expect(parseAssertion("header:content-type=application/json")).toEqual({
      kind: "header_equals",
      target: "content-type",
      expected: "application/json",
    });
    expect(parseAssertion("header:x-count=5").expected).toBe("5");
  });

  it("lowers body=<value> to a substring check over the raw body", () => {
    expect(parseAssertion("body=ready")).toEqual({ kind: "body_contains", expected: "ready" });
  });

  it("rejects a json or header assertion that never named its subject", () => {
    expect(rejection("json=first")).toContain("needs a path");
    expect(rejection("header=application/json")).toContain("needs a header name");
  });

  it("rejects a subject it does not recognise, naming the subject", () => {
    expect(rejection("mystery=1")).toContain("mystery");
  });
});

describe("parseAssertion: latency and size", () => {
  it("reads a duration in milliseconds, seconds, or minutes", () => {
    expect(parseAssertion("latency<250ms")).toEqual({ kind: "latency_under_ms", expected: 250 });
    expect(parseAssertion("latency<250").expected).toBe(250);
    expect(parseAssertion("latency<2s").expected).toBe(2000);
    expect(parseAssertion("latency<1.5s").expected).toBe(1500);
    expect(parseAssertion("latency<1m").expected).toBe(60_000);
    expect(parseAssertion("latency < 2s").expected).toBe(2000);
  });

  it("reads a body size limit", () => {
    expect(parseAssertion("body_bytes<1024")).toEqual({ kind: "body_bytes_under", expected: 1024 });
    expect(parseAssertion("bytes<512")).toEqual({ kind: "body_bytes_under", expected: 512 });
  });

  it("rejects a duration it cannot read, naming what it saw", () => {
    // Anything other than `latency<…` falls through to the generic rejection, so
    // a comparison the evaluator has no kind for is refused rather than guessed.
    expect(rejection("latency<soon")).toContain("not a duration");
    expect(rejection("latency<soon")).toContain("soon");
  });
});

describe("parseAssertion: the negotiated protocol version", () => {
  it("lowers http_version=2.0 to the version assertion, as a string", () => {
    expect(parseAssertion("http_version=2.0")).toEqual({
      kind: "http_version_equals",
      expected: "2.0",
    });
  });

  it("keeps the version a string even when it parses as a number", () => {
    // `JSON.parse("2.0")` is the number `2`, and the evaluator compares the
    // observed version exactly — so a parser that ran the value through the
    // shared literal helper would produce `http_version=2.0` meaning "the peer
    // reported the number 2", which no exchange ever does. The assertion would
    // fail against a service that did exactly what was asked.
    const { expected } = parseAssertion("http_version=2.0");
    expect(typeof expected).toBe("string");
    expect(expected).toBe("2.0");
    expect(parseAssertion("http_version=1.1").expected).toBe("1.1");
  });

  it("rejects a version it was not given, rather than asserting the empty string", () => {
    expect(rejection("http_version=")).toContain("http_version=");
  });
});

describe("parseAssertion: negation", () => {
  it("expresses negation with a leading !", () => {
    // This syntax can say "not that": a leading `!` sets `negate`. That is
    // deliberate, and it is why the two surfaces differ — `uvp assert` accepts
    // these because uvp_assert_exchange's contract carries a `negate` field,
    // while `uvp verify` refuses them (src/cli/commands/project.ts:377-385)
    // because uvp_verify's assertion schema has no such field, so accepting one
    // there would drop it silently and report a negated check as the assertion
    // the caller asked for.
    expect(parseAssertion("!status=200")).toEqual({
      kind: "status_equals",
      expected: 200,
      negate: true,
    });
    expect(parseAssertion("!header:x=1")).toEqual({
      kind: "header_equals",
      target: "x",
      expected: "1",
      negate: true,
    });
  });

  it("carries negation for a JSON object as a field, since that form has its own vocabulary", () => {
    // The `!` prefix belongs to the compact spellings. A JSON assertion states
    // `negate` itself, which is how the escape hatch covers a negated match.
    expect(parseAssertion('{"kind":"status_equals","expected":200,"negate":true}')).toEqual({
      kind: "status_equals",
      expected: 200,
      negate: true,
    });
  });

  it("applies the ! prefix to a JSON object too, rather than refusing it", () => {
    // `!` is stripped before the escape hatch is tested, so it negates every
    // form. Testing the hatch first sent `!{…}` to the comparison parser, which
    // found no `=` in the JSON and rejected it with advice to pass "a JSON
    // object" — the very thing the caller had passed — while the spelling that
    // works went unmentioned.
    expect(parseAssertion('!{"kind":"body_contains","expected":"x"}')).toEqual({
      kind: "body_contains",
      expected: "x",
      negate: true,
    });
    // The object's own `negate` field and the prefix agree rather than fighting,
    // so a caller who writes both gets a negated check and not a double negation.
    expect(parseAssertion('!{"kind":"body_contains","expected":"x","negate":true}')).toEqual({
      kind: "body_contains",
      expected: "x",
      negate: true,
    });
  });
});

describe("parseAssertion: the JSON escape hatch", () => {
  it("passes a JSON object through for the contract to validate", () => {
    // The evaluator's vocabulary is larger than this syntax covers
    // (`body_bytes_under`, `status_in`, a negated match). The escape hatch is
    // how those reach the same evaluator, rather than the syntax growing a
    // spelling for every kind.
    expect(parseAssertion('{"kind":"body_bytes_under","expected":10}')).toEqual({
      kind: "body_bytes_under",
      expected: 10,
    });
  });

  it("rejects JSON that does not parse, keeping the parser's complaint", () => {
    expect(rejection("{oops}")).toContain("is not valid JSON");
  });
});

describe("parseAssertion: rejection is a usable message", () => {
  it("names the forms it accepts, because that message is the remedy", () => {
    const message = rejection("nonsense");
    expect(message).toContain("nonsense");
    expect(message).toContain("status=200");
    expect(message).toContain("latency<250ms");
  });

  it("is a user error the CLI can render, not a crash", () => {
    try {
      parseAssertion("nonsense");
      throw new Error("the fixture was supposed to fail");
    } catch (cause) {
      expect(isUvpFailure(cause)).toBe(true);
      if (!isUvpFailure(cause)) throw new Error("unreachable");
      expect(cause.detail.code).toBe("invalid_request");
      expect(cause.detail.remediation.action).toContain("--help");
    }
  });
});

describe("parseAssertionList", () => {
  it("reads the existence forms, which are the ones with no = at all", () => {
    // `header:<name>` and `json:<path>` mean "is it there" — the one shape a
    // comparison cannot express, and the one an agent wants when probing a
    // response whose value it does not know yet.
    expect(parseAssertionList(["header:content-type"])).toEqual([
      { kind: "header_exists", target: "content-type" },
    ]);
    expect(parseAssertionList(["json:$.items"])).toEqual([
      { kind: "body_json_path_exists", target: "$.items" },
    ]);
  });

  it("delegates every comparison form to parseAssertion, keeping the order", () => {
    expect(parseAssertionList(["status=200", "header:x=1"]).map((entry) => entry.kind)).toEqual([
      "status_equals",
      "header_equals",
    ]);
  });

  it("rejects an existence form for a namespace that has none", () => {
    // `body:substring` looks like the other two and is not one of them; refusing
    // it is better than reading it as a JSONPath comparison that would compare
    // nothing.
    expect(() => parseAssertionList(["body:substring"])).toThrow(/not an assertion/u);
  });

  it("hands an empty list back as an empty list", () => {
    expect(parseAssertionList([])).toEqual([]);
  });
});

describe("the regex forms and the evaluator", () => {
  it("puts a body regex where the evaluator reads it, so the check can fail", () => {
    // The pattern belongs in `expected`, which is where `bodyMatches` reads it —
    // the shape `header_matches` already used. In `target` it is never read, and
    // the evaluator falls back to the empty pattern, which matches every body:
    // `uvp assert --assert 'body~=x'` would report success whatever came back,
    // which is the worst outcome a verification tool can produce.
    expect(parseAssertion("body~=^hello$")).toEqual({ kind: "body_matches", expected: "^hello$" });
    // Cross-checked against the evaluator's own reading of the field, so this
    // test cannot pass merely by agreeing with the lowering.
    expect(parseAssertion("body~=^hello$").target).toBeUndefined();
  });

  it("rejects a path-scoped regex rather than weakening it to a whole-body check", () => {
    // No kind in the evaluator's vocabulary applies a regex to a JSON path, so
    // there is nothing honest to lower this to. Accepting it would discard
    // `$.value` and leave a whole-body check that still reads as scoped — a
    // check that cannot fail, presented as one that can.
    const message = rejection("json:$.value~=^a");
    expect(message).toContain("$.value");
    // The remedy names the two forms that can be written instead, because a
    // rejection without one just tells the caller that something is impossible.
    expect(message).toContain("json:$.value=");
    expect(message).toContain("body~=");
    // And the unscoped regex is still accepted, so the guard is narrow.
    expect(parseAssertion("body~=^a")).toEqual({ kind: "body_matches", expected: "^a" });
  });
});
