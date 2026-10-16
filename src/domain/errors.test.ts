import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  UvpFailure,
  type UvpErrorCode,
  isUvpFailure,
  parseUvpError,
  toUvpError,
  uvpErrorCategorySchema,
  uvpErrorCodeSchema,
} from "./errors.js";

/**
 * The error contract is the only thing every surface agrees on: the CLI prints
 * it, the MCP server puts it in `structuredContent.error`, and an agent decides
 * whether to retry from it. A code that reaches the wrong category, or a retry
 * verdict the caller can set by hand, is a wrong decision made downstream.
 */

const CODES = uvpErrorCodeSchema.options;

describe("the code vocabulary", () => {
  it("maps every code to a category the schema admits", () => {
    for (const code of CODES) {
      const failure = new UvpFailure({
        code,
        message: "m",
        remediation: { action: "a" },
      });
      expect(uvpErrorCategorySchema.safeParse(failure.detail.category).success).toBe(true);
    }
  });

  it("gives every code a category, rather than falling through to a default", () => {
    const categories = CODES.map(
      (code) =>
        new UvpFailure({ code, message: "m", remediation: { action: "a" } }).detail.category,
    );
    // A `Record<UvpErrorCode, …>` this size is easy to leave a hole in, and a
    // hole shows up as `undefined` rather than as a type error.
    expect(categories.every((category) => typeof category === "string")).toBe(true);
  });
});

describe("UvpFailure", () => {
  it("derives `retryable` from the code, so a caller cannot assert it", () => {
    const retryable = new UvpFailure({
      code: "endpoint_unreachable",
      message: "m",
      remediation: { action: "a" },
    });
    expect(retryable.detail.retryable).toBe(true);

    const notRetryable = new UvpFailure({
      code: "invalid_request",
      message: "m",
      remediation: { action: "a" },
    });
    expect(notRetryable.detail.retryable).toBe(false);
  });

  it("treats a missing requirement as the caller's problem, not a temporary one", () => {
    // The distinction that matters most in practice: an agent that retries a
    // missing compiler burns a loop instead of installing one.
    for (const code of ["missing_requirement", "compiler_unavailable", "libuvcpp_unavailable"]) {
      const failure = new UvpFailure({ code, message: "m", remediation: { action: "a" } } as never);
      expect(failure.detail.retryable).toBe(false);
    }
  });

  it("never calls a target problem retryable, however temporary it sounds", () => {
    // `target_unavailable` reads like `service_unavailable` and is the opposite
    // kind of fact: the caller's environment is wrong in a way that no amount of
    // asking again will change. It arrives as `unsupported_target` — the exit
    // code that says the question could not be put — and a `true` beside it was
    // the one thing in the contract a retry loop would act on.
    const failure = new UvpFailure({
      code: "target_unavailable",
      message: "m",
      remediation: { action: "a" },
    });
    expect(failure.detail.category).toBe("unsupported_target");
    expect(failure.detail.retryable).toBe(false);
  });

  it("omits `details` entirely when there are none, rather than writing an empty object", () => {
    const failure = new UvpFailure({
      code: "build_failed",
      message: "m",
      remediation: { action: "a" },
    });
    expect(failure.detail).not.toHaveProperty("details");
  });

  it("calls exactly the codes the environment might fix on a retry retryable", () => {
    // The first mutation sweep named `src/domain/errors.ts`'s fourteen survivors
    // (#31); reading them found three of these four unpinned: the test above pinned
    // `endpoint_unreachable` alone, so `service_unavailable`, `timeout` and
    // `resource_constraint` could each be emptied out of the set with the whole
    // suite still passing — and an emptied member answers `retryable: false` for
    // a failure nobody said was permanent.
    //
    // The whole set is asserted rather than one code at a time, so a code added to
    // the set fails here too. `capture_unavailable` is the one code whose category
    // reads `unavailable` and which the set deliberately omits: it carries two
    // meanings, and only one of them is temporary. That is
    // [#49](https://github.com/Antruly/uvp/issues/49).
    const retryable = CODES.filter(
      (code) =>
        new UvpFailure({ code, message: "m", remediation: { action: "a" } }).detail.retryable,
    );
    // Sorted, because which codes are retryable is the invariant and the schema's
    // declaration order is not.
    const expected: UvpErrorCode[] = [
      "service_unavailable",
      "endpoint_unreachable",
      "timeout",
      "resource_constraint",
    ];
    expect([...retryable].sort()).toEqual([...expected].sort());
  });

  it("keeps a remediation link through construction, and omits the key when there is none", () => {
    // The conditional spread that carries `docs` was unpinned in every direction
    // the sweeper can turn it: dropping it, always including it, and inverting
    // the test were all survivable, because the test above compared a detail to
    // itself and so agreed with whatever came out. Both halves are asserted here
    // — the link survives when it is given, and the key is absent when it is not,
    // which is the same promise the `details` test above makes.
    const withDocs = new UvpFailure({
      code: "build_failed",
      message: "m",
      remediation: { action: "a", docs: "https://example.test/build" },
    });
    expect(withDocs.detail.remediation.docs).toBe("https://example.test/build");

    const withoutDocs = new UvpFailure({
      code: "build_failed",
      message: "m",
      remediation: { action: "a" },
    });
    expect(withoutDocs.detail.remediation).not.toHaveProperty("docs");
  });

  it("is recognisable in a log line, not only by identity", () => {
    const failure = new UvpFailure({
      code: "build_failed",
      message: "m",
      remediation: { action: "a" },
    });
    expect(failure.name).toBe("UvpFailure");
  });

  it("produces a detail that satisfies the published contract", () => {
    const failure = new UvpFailure({
      code: "timeout",
      message: "m",
      remediation: { action: "a", docs: "https://example.test" },
      details: { elapsed_ms: 10 },
    });
    expect(parseUvpError(failure.detail)).toEqual(failure.detail);
  });

  it("is recognisable across a module boundary by shape, not only by identity", () => {
    expect(
      isUvpFailure(new UvpFailure({ code: "timeout", message: "m", remediation: { action: "a" } })),
    ).toBe(true);
    expect(isUvpFailure(new Error("m"))).toBe(false);
    expect(isUvpFailure(undefined)).toBe(false);
  });
});

describe("toUvpError", () => {
  it("unwraps a UvpFailure to its detail", () => {
    const failure = new UvpFailure({
      code: "build_failed",
      message: "nope",
      remediation: { action: "a" },
    });
    expect(toUvpError(failure)).toEqual(failure.detail);
  });

  it("projects a schema violation as invalid_request, naming the field", () => {
    // This is the promise `docs/cli.md` makes: a bad invocation is the caller's
    // malformed request, not a uvp crash. It reaches here as a ZodError thrown
    // by the contract's own parse at the handler's edge.
    const schema = z.object({ requests: z.array(z.object({ path: z.string() })) });
    const result = schema.safeParse({ requests: [{ path: 7 }] });
    if (result.success) throw new Error("the fixture was supposed to fail");

    const error = toUvpError(result.error);
    expect(error.code).toBe("invalid_request");
    expect(error.category).toBe("invalid_input");
    expect(error.message).toContain("requests.0.path");
    expect(error.retryable).toBe(false);
  });

  it("keeps every issue, so a form with three bad fields needs one round trip", () => {
    const schema = z.object({ a: z.string(), b: z.number(), c: z.boolean() });
    const result = schema.safeParse({});
    if (result.success) throw new Error("the fixture was supposed to fail");

    const error = toUvpError(result.error);
    expect(error.details?.["issues"]).toHaveLength(3);
  });

  it("names the field for a violation of the value itself, not of a member", () => {
    const result = z.string().safeParse(7);
    if (result.success) throw new Error("the fixture was supposed to fail");

    const error = toUvpError(result.error);
    // No path means no prefix: `"7: Expected string"` would read as though `7`
    // were a field name.
    expect(error.message.startsWith(":")).toBe(false);
    expect(error.message).not.toBe("");
  });

  it("still answers when a schema violation carries no issues", () => {
    // `z.ZodError` is constructible with an empty issue list, which is why
    // `invalidRequest` guards the first issue rather than reaching into it. The
    // guard was unpinned: removing it made this projector throw a `TypeError`
    // instead of reporting, and this is the last resort in a catch block, so a
    // throw here replaces a reportable failure with a stack trace.
    const error = toUvpError(new z.ZodError([]));
    expect(error.code).toBe("invalid_request");
    expect(error.message).not.toBe("");
    expect(error.message.startsWith(":")).toBe(false);
  });

  it("falls back to a reason when the cause is only whitespace", () => {
    // `describeCause` trims before it decides whether it has a message, and the
    // trim was unpinned: without it a cause of `"  "` came back as `"  "`, which
    // satisfies the contract's minimum length and tells the caller nothing.
    expect(toUvpError("   ").message).toBe("The tool failed without reporting a reason.");
    expect(toUvpError(new Error("\n")).message).toBe("The tool failed without reporting a reason.");
  });

  it("reports an unrecognised Error as execution_failure, keeping its message", () => {
    const error = toUvpError(new TypeError("cannot read properties of undefined"));
    expect(error.code).toBe("execution_failure");
    expect(error.message).toBe("cannot read properties of undefined");
    expect(error.retryable).toBe(false);
    // The name survives, because `TypeError` and `RangeError` point at different
    // bugs and the message alone does not distinguish them.
    expect(error.details?.["name"]).toBe("TypeError");
  });

  it("reports a thrown non-Error without losing it", () => {
    const error = toUvpError("the toolchain printed this");
    expect(error.code).toBe("execution_failure");
    expect(error.message).toBe("the toolchain printed this");
    // The `Error` branch above pins this; the non-`Error` branch did not, so a
    // failure built from a thrown string could have answered `retryable: true`
    // with every test still passing.
    expect(error.retryable).toBe(false);
  });

  it("always returns a value that satisfies the contract, whatever it was handed", () => {
    for (const cause of [undefined, null, 0, "", Symbol("s"), { code: "timeout" }, []]) {
      expect(parseUvpError(toUvpError(cause))).toEqual(toUvpError(cause));
    }
  });
});
