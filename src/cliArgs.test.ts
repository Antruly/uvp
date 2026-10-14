import { describe, expect, it } from "vitest";

import {
  UNIVERSAL_FLAGS,
  asBoolean,
  asList,
  asNumber,
  asString,
  parseArgv,
  parseCsv,
  parseHeaders,
  parsePairs,
  requirePositional,
} from "./cli/args.js";
import type { FlagSpec } from "./cli/args.js";
import { UvpFailure, isUvpFailure, parseUvpError } from "./domain/errors.js";

/**
 * `parseArgv` is the boundary where a user's typing becomes a tool input.
 *
 * Every mistake it lets through is a request the user did not make. A flag
 * dropped in silence, a positional shifted into the wrong slot, or a number read
 * as `NaN` all reach the contract as a well-formed call for something else — and
 * the contract, which only validates what it is given, will not notice. So the
 * assertions below are about what the words mean, not about the shape of the
 * returned record.
 */

const FLAGS: readonly FlagSpec[] = [
  { name: "port", type: "number", value: "PORT", description: "Wait until this port answers." },
  { name: "build-dir", type: "string", value: "PATH", description: "Build directory." },
  { name: "arg", type: "list", value: "VALUE", description: "An argument for the service." },
  { name: "request", type: "pair", value: "METHOD PATH", description: "A request to issue." },
  { name: "header", type: "list", value: "NAME:VALUE", description: "A header." },
  { name: "force", type: "boolean", description: "Escalate to a hard kill." },
  { name: "tls", type: "boolean", description: "Verify the server certificate." },
];

/** Whatever the call threw; a bare `throw new Error` here means the test lied. */
const captures = (run: () => unknown): unknown => {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error("the call was expected to fail");
};

/**
 * The user error a failed parse reports.
 *
 * Asserting the *shape* matters as much as the fact of the failure: `docs/cli.md`
 * promises that a bad invocation arrives as `invalid_request` with a remedy, so
 * a bare `Error` here would reach a user as a crash rather than as usage text.
 */
const userFailure = (run: () => unknown): UvpFailure => {
  const cause = captures(run);
  if (!isUvpFailure(cause)) throw new Error(`expected a UvpFailure, got ${String(cause)}`);
  return cause;
};

const failureFrom = (argv: readonly string[], flags: readonly FlagSpec[] = FLAGS): UvpFailure =>
  userFailure(() => parseArgv(argv, flags));

describe("parseArgv: positionals", () => {
  it("keeps the positional arguments in the order they were typed", () => {
    // `uvp http GET URL` and `uvp http URL` differ only in this list, so the
    // order is the meaning rather than a presentation detail.
    expect(parseArgv(["build", "./svc", "extra"], []).positionals).toEqual([
      "build",
      "./svc",
      "extra",
    ]);
  });

  it("collects positionals that a flag was typed between, without reordering them", () => {
    expect(parseArgv(["build", "--force", "./svc"], FLAGS).positionals).toEqual(["build", "./svc"]);
  });

  it("treats a lone dash as a positional, not as a flag", () => {
    // `-` is the conventional stand-in for stdin or stdout, so a parser that
    // read it as an empty flag would make that convention unusable.
    expect(parseArgv(["-"], FLAGS).positionals).toEqual(["-"]);
    expect(parseArgv(["--build-dir", "-"], FLAGS).occurrences).toEqual([
      { name: "build-dir", values: ["-"] },
    ]);
  });
});

describe("parseArgv: flag values", () => {
  it("reads --flag value and --flag=value as the same flag", () => {
    expect(parseArgv(["--port", "8080"], FLAGS).values.port).toBe(8080);
    expect(parseArgv(["--port=8080"], FLAGS).values.port).toBe(8080);
  });

  it("consumes a string flag's value, so it does not leak into the positionals", () => {
    const parsed = parseArgv(["--build-dir", "/tmp/a b", "build"], FLAGS);
    expect(parsed.positionals).toEqual(["build"]);
    expect(parsed.occurrences).toEqual([{ name: "build-dir", values: ["/tmp/a b"] }]);
  });

  it("stores a string flag's value where asString reads it", () => {
    // Two places hold a flag's value and they serve different readers: `values`
    // is what the `asString`/`asNumber`/`asList` accessors read, and
    // `occurrences` is the ordered log a command with pairing semantics reads.
    // A kind that writes only the second is consumed, raises nothing, and is
    // read back as `undefined` — so every string flag the CLI declares would be
    // inert: `uvp build . --build-type Release` would build Debug, and
    // `uvp assert --exchange exc_…` would report a missing --exchange.
    expect(parseArgv(["--build-dir", "/tmp/a b"], FLAGS).values["build-dir"]).toBe("/tmp/a b");
    // The inline spelling has to land in the same place, or the two ways of
    // writing one flag would differ in whether they work.
    expect(parseArgv(["--build-dir=/tmp/a b"], FLAGS).values["build-dir"]).toBe("/tmp/a b");
  });

  it("never reads a flag of one kind back as another kind's value", () => {
    // The accessors are typed, not coercing: `asString` on a number flag is
    // `undefined` rather than `"8080"`. That is what makes a wrong accessor a
    // visible bug instead of a silently mistyped value.
    const parsed = parseArgv(["--port", "8080"], FLAGS);
    expect(asNumber(parsed, "port")).toBe(8080);
    expect(asString(parsed, "port")).toBeUndefined();
  });

  it("never lets a boolean flag swallow the token that follows it", () => {
    // The failure this prevents: `uvp build --clean ./svc` losing the workspace
    // path to `--clean`, which then fails as "missing a workspace path" and
    // sends the user looking in the wrong place.
    const parsed = parseArgv(["--force", "./svc"], FLAGS);
    expect(parsed.values.force).toBe(true);
    expect(parsed.positionals).toEqual(["./svc"]);
  });

  it("rejects a value given to a switch instead of reading it as truth", () => {
    // `--force=yes` parsed as a switch would accept `--clean=no` as "clean".
    expect(failureFrom(["--force=yes"]).detail.message).toContain("takes no value");
  });

  it("reports a value flag that ran out of arguments rather than inventing a value", () => {
    expect(failureFrom(["--port"]).detail.message).toContain("needs 1 value(s), got 0");
    // A flag is consumed as a flag, never as another flag's value.
    expect(failureFrom(["--port", "--force"]).detail.message).toContain("needs 1 value(s), got 0");
  });

  it("consumes two tokens for a pair flag, which is why it has no = spelling", () => {
    expect(parseArgv(["--request", "GET", "/a"], FLAGS).values.request).toEqual(["GET", "/a"]);
    expect(failureFrom(["--request=GET"]).detail.message).toContain("takes two values");
    expect(failureFrom(["--request", "GET"]).detail.message).toContain("needs 2 value(s), got 1");
  });
});

describe("parseArgv: repeats and order", () => {
  it("accumulates a list flag in first-seen order, dropping nothing", () => {
    expect(asList(parseArgv(["--arg", "a", "--arg", "b", "--arg", "c"], FLAGS), "arg")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps every occurrence, because order is the association for grouped flags", () => {
    // `uvp verify --request … --header … --data … --assert …` groups by order of
    // appearance (src/cli/commands/project.ts collectRequests). A record has
    // thrown that order away, so `occurrences` is the only place it survives —
    // and `values` deliberately holds just the last pair.
    const parsed = parseArgv(
      ["--request", "GET", "/a", "--header", "x: 1", "--request", "POST", "/b", "--header", "x: 2"],
      FLAGS,
    );
    expect(
      parsed.occurrences.map((occurrence) => [occurrence.name, [...occurrence.values]]),
    ).toEqual([
      ["request", ["GET", "/a"]],
      ["header", ["x: 1"]],
      ["request", ["POST", "/b"]],
      ["header", ["x: 2"]],
    ]);
    expect(parsed.values.request).toEqual(["POST", "/b"]);
  });

  it("records every occurrence of a switch too, rather than collapsing it", () => {
    // A count of occurrences is how a caller distinguishes "asked once" from
    // "asked twice"; deriving it from a boolean would lose that.
    const parsed = parseArgv(["--force", "--force"], FLAGS);
    expect(parsed.occurrences.map((occurrence) => occurrence.name)).toEqual(["force", "force"]);
    expect(parsed.values.force).toBe(true);
  });
});

describe("parseArgv: negation", () => {
  it("turns a defaulted-on switch off with a --no- prefix", () => {
    const parsed = parseArgv(["--no-tls"], FLAGS);
    expect(parsed.values.tls).toBe(false);
    expect(asBoolean(parsed, "tls")).toBe(false);
    expect(parsed.occurrences.map((occurrence) => occurrence.name)).toEqual(["tls"]);
  });

  it("refuses a --no- prefix on a flag that is not a switch", () => {
    // `--no-port 8080` would otherwise read as a request to unset a port, which
    // is not a thing.
    expect(failureFrom(["--no-port"]).detail.message).toContain("only meaningful for a switch");
  });

  it("rejects a value given to a negated switch, as it does for a plain one", () => {
    // The negation is checked before it is applied, by the same rule the plain
    // form uses. Without that, `--no-tls=true` sets `tls` to false — the
    // opposite of what was typed — and `--no-json=false` turns `json` off, both
    // while `--tls=true` and `--force=yes` are rejected as malformed.
    expect(() => parseArgv(["--no-tls=true"], FLAGS)).toThrow(/takes no value/u);
    expect(() => parseArgv(["--no-force=false"], FLAGS)).toThrow(/takes no value/u);
    // And a bare negated switch still works, so the check did not disable the
    // feature it guards.
    expect(parseArgv(["--no-tls"], FLAGS).values["tls"]).toBe(false);
  });
});

describe("parseArgv: -- and --help", () => {
  it("stops reading flags at --, and does not treat -- itself as an argument", () => {
    // The escape hatch for a path or a body that begins with a dash.
    const parsed = parseArgv(["--force", "--", "--json", "-x"], FLAGS);
    expect(parsed.positionals).toEqual(["--json", "-x"]);
    expect(parsed.values.json).toBeUndefined();
    expect(parsed.values.force).toBe(true);
  });

  it("accepts --json and --help on a command that declares neither", () => {
    for (const spec of UNIVERSAL_FLAGS) {
      expect(parseArgv([`--${spec.name}`], []).values[spec.name]).toBe(true);
    }
    expect(parseArgv(["--json"], []).help).toBe(false);
  });

  it("reaches --help on a command whose own flags were not supplied", () => {
    // Missing required flags are deliberately not checked here
    // (src/cli/args.ts:112-119): `--help` has to be reachable on the command
    // the user is asking about, which is the whole reason it exists.
    expect(parseArgv(["--help"], FLAGS).help).toBe(true);
    expect(parseArgv(["-h"], FLAGS).help).toBe(true);
  });
});

describe("parseArgv: numbers", () => {
  it("reads a number flag as a number rather than as its text", () => {
    const parsed = parseArgv(["--port", "8080"], FLAGS);
    expect(typeof parsed.values.port).toBe("number");
    expect(asNumber(parsed, "port")).toBe(8080);
  });

  it("rejects a value that is not a number instead of letting NaN reach the contract", () => {
    // `NaN` is a plausible-looking value to a schema that only says `number`,
    // and a port of NaN would be reported as a range error somewhere else.
    for (const raw of ["abc", "12abc", "NaN", "Infinity", "1e", "0x"]) {
      expect(failureFrom(["--port", raw]).detail.message).toContain("expects a number");
    }
  });

  it("refuses a value with no digits at all instead of reading it as zero", () => {
    // `Number("")` and `Number(" ")` are both `0`, and zero is finite, so an
    // empty value used to pass the is-finite check and become a valid zero:
    // `--port ""` asked for port 0 and `uvp run . --timeout ""` asked for an
    // immediate timeout, neither reporting the mistake. A digit is now required,
    // which keeps "typed nothing" distinct from "typed zero".
    for (const raw of ["", " ", "\t"]) {
      expect(failureFrom(["--port", raw]).detail.message).toContain("expects a number");
    }
    // The inline spelling reaches the same parse and is refused the same way.
    expect(failureFrom(["--port="]).detail.message).toContain("expects a number");
    // A real zero is still a number, so the guard did not outlaw it.
    expect(parseArgv(["--port", "0"], FLAGS).values["port"]).toBe(0);
  });

  it("reads a missing number flag as absent rather than as zero", () => {
    const parsed = parseArgv([], FLAGS);
    expect(asNumber(parsed, "port")).toBeUndefined();
    expect(parsed.values.port).toBeUndefined();
  });
});

describe("parseArgv: unknown flags", () => {
  it("rejects a flag it does not know rather than ignoring it", () => {
    // The worst outcome this parser can produce: a silently dropped flag means
    // the tool ran with a different intent from the one the user typed, and the
    // result looks like an answer to the request they made.
    const failure = failureFrom(["--nope"]);
    expect(failure.detail.message).toBe("Unknown flag --nope.");
    expect(failure.detail.code).toBe("invalid_request");
    expect(failure.detail.category).toBe("invalid_input");
    expect(failure.detail.retryable).toBe(false);
    expect(failure.detail.details?.["flag"]).toBe("nope");
    expect(failure.detail.remediation.action).toContain("--help");
  });

  it("suggests the nearest spelling without accepting it", () => {
    // A suggestion is a diagnostic, never a fallback: accepting `--por` as
    // `--port` would make a typo into a decision.
    const failure = failureFrom(["--por"]);
    expect(failure.detail.message).toContain("Unknown flag --por.");
    expect(failure.detail.message).toContain("Did you mean --port?");
  });

  it("accepts an unknown-looking word after -- as a positional", () => {
    expect(parseArgv(["--", "--nope"], FLAGS).positionals).toEqual(["--nope"]);
  });
});

describe("requirePositional", () => {
  it("returns the argument when it is there", () => {
    expect(
      requirePositional(parseArgv(["./svc"], []), 0, "a workspace path", "uvp build ./svc"),
    ).toBe("./svc");
  });

  it("reports a missing argument as a user error the CLI can render", () => {
    // Not a bare `Error`: a missing argument is the caller's malformed request,
    // and the remedy ("run it like this") has to survive to the renderer.
    let caught: unknown;
    try {
      requirePositional(parseArgv([], []), 0, "a workspace path", "uvp build ./svc");
    } catch (cause) {
      caught = cause;
    }
    expect(isUvpFailure(caught)).toBe(true);
    if (!isUvpFailure(caught)) throw new Error("unreachable");
    expect(caught.detail.code).toBe("invalid_request");
    expect(caught.detail.category).toBe("invalid_input");
    expect(caught.detail.retryable).toBe(false);
    expect(caught.detail.message).toBe("Missing a workspace path.");
    expect(caught.detail.details?.["usage"]).toBe("uvp build ./svc");
    expect(parseUvpError(caught.detail)).toEqual(caught.detail);
  });

  it("treats an empty argument as missing, because an empty path is not a path", () => {
    const failure = userFailure(() =>
      requirePositional(parseArgv([""], []), 0, "a workspace path", "uvp build ./svc"),
    );
    expect(failure.detail.message).toBe("Missing a workspace path.");
  });
});

describe("parseHeaders", () => {
  it("accepts both `name: value` and `name=value`", () => {
    expect(parseHeaders(["content-type: application/json", "x=1"])).toEqual({
      "content-type": "application/json",
      x: "1",
    });
  });

  it("lowercases the name so two spellings are one header", () => {
    // HTTP header names are case-insensitive, and the evaluator looks them up
    // lowercased; keeping the caller's casing would make `--assert
    // header:Content-Type=…` match a header the tool did record.
    expect(parseHeaders(["Content-Type: text/html"])).toEqual({ "content-type": "text/html" });
    expect(parseHeaders(["X: 1", "x: 2"])).toEqual({ x: "2" });
  });

  it("splits on the first separator, so a value may contain both characters", () => {
    expect(parseHeaders(["authorization: Bearer a:b"])).toEqual({
      authorization: "Bearer a:b",
    });
    expect(parseHeaders(["x: a=b"])).toEqual({ x: "a=b" });
  });

  it("rejects an entry with no separator or no name, naming the entry", () => {
    expect(userFailure(() => parseHeaders(["Content-Type"])).detail.message).toContain(
      '"Content-Type" is not a header',
    );
    expect(userFailure(() => parseHeaders([": value"])).detail.message).toContain(
      '": value" is not a header',
    );
  });
});

describe("parsePairs", () => {
  it("splits on the first =, so a value may contain one", () => {
    expect(parsePairs(["a=b=c"])).toEqual({ a: "b=c" });
  });

  it("allows an empty value, which is a value", () => {
    expect(parsePairs(["a="])).toEqual({ a: "" });
  });

  it("rejects an entry with no name rather than storing an empty key", () => {
    expect(() => parsePairs(["=1"])).toThrow(/not a key=value pair/u);
    expect(() => parsePairs(["plain"])).toThrow(/"plain"/u);
  });
});

describe("parseCsv", () => {
  it("splits on commas, trims, and drops empty pieces", () => {
    expect(parseCsv([" a, b ,,c "])).toEqual(["a", "b", "c"]);
  });

  it("de-duplicates across entries while keeping first-seen order", () => {
    expect(parseCsv(["b,a", "a,c"])).toEqual(["b", "a", "c"]);
  });

  it("returns nothing for no entries", () => {
    expect(parseCsv([])).toEqual([]);
  });
});

describe("asString and asList", () => {
  it("do not coerce one flag's type into another's", () => {
    // A reader that coerced would turn `--force` into the string "true", and
    // `--arg x` into a string where the caller wanted a list.
    const parsed = parseArgv(["--force", "--arg", "x"], FLAGS);
    expect(asString(parsed, "force")).toBeUndefined();
    expect(asList(parsed, "force")).toEqual(["true"]);
    expect(asString(parsed, "arg")).toBeUndefined();
  });

  it("reads a flag that was not supplied as absent rather than as a placeholder", () => {
    // Absent, not empty: none of these flags was typed, which is why `undefined`
    // is the right answer for the string reader here.
    const parsed = parseArgv([], FLAGS);
    expect(asList(parsed, "arg")).toEqual([]);
    expect(asString(parsed, "build-dir")).toBeUndefined();
    expect(asBoolean(parsed, "force")).toBeUndefined();
  });
});
