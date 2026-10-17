import { describe, expect, it } from "vitest";

import {
  compareUnknowns,
  createResidualUnknown,
  residualUnknownSchema,
  sortUnknowns,
  unknownReasonSchema,
} from "./unknown.js";

/**
 * A residual unknown is the difference between "we did not check" and "we
 * checked and it was fine". Both look like silence in a report, and this is the
 * structure that keeps them apart — so a reason that cannot be acted on, or an
 * unknown that quietly disappears, defeats the whole model.
 */

const id = (suffix: string) => `unk_${suffix.padEnd(22, "0").slice(0, 22)}`;

describe("the reason vocabulary", () => {
  it("separates a question nobody asked from one the environment forbade", () => {
    // These lead to different follow-ups: `not_attempted` means ask again,
    // `toolchain_missing` means install something, `unsupported_by_build` means
    // rebuild libuvcpp with the module enabled.
    for (const reason of ["not_attempted", "toolchain_missing", "unsupported_by_build"]) {
      expect(unknownReasonSchema.safeParse(reason).success).toBe(true);
    }
  });

  it("has no reason for a question that was answered", () => {
    expect(unknownReasonSchema.safeParse("verified").success).toBe(false);
    expect(unknownReasonSchema.safeParse("ok").success).toBe(false);
  });

  it("publishes exactly the reasons the contract enumerates, in declaration order", () => {
    // This enum is a published vocabulary: an agent reads `reason` to decide
    // whether to retry, install something, rebuild, or escalate, so a member
    // that changes spelling — or becomes the empty string — changes an answer
    // rather than a label. Listing the members here means adding, removing, or
    // misspelling one is a diff in this file instead of a silent change to the
    // contract. The list is the contract's own, not a restatement to satisfy
    // the schema: the test below re-parses each of these through the schema.
    const members = [
      "not_attempted",
      "toolchain_missing",
      "unsupported_by_platform",
      "unsupported_by_build",
      "out_of_scope",
      "resource_limit",
      "cancelled",
      "ambiguous_requirement",
    ];
    expect(unknownReasonSchema.options).toEqual(members);
    for (const reason of members) {
      expect(unknownReasonSchema.safeParse(reason).success).toBe(true);
    }
  });
});

describe("createResidualUnknown", () => {
  it("renders the id under its contract field name", () => {
    expect(createResidualUnknown({ id: id("a"), question: "q", reason: "out_of_scope" })).toEqual({
      unknown_id: id("a"),
      question: "q",
      reason: "out_of_scope",
    });
  });

  it("omits `blocked_by` when nothing is known to be blocking", () => {
    const unknown = createResidualUnknown({ id: id("a"), question: "q", reason: "not_attempted" });
    expect(unknown).not.toHaveProperty("blocked_by");
  });

  it("omits `partial_evidence` when there is none, rather than writing an empty list", () => {
    const unknown = createResidualUnknown({
      id: id("a"),
      question: "q",
      reason: "not_attempted",
      partialEvidence: [],
    });
    expect(unknown).not.toHaveProperty("partial_evidence");
  });

  it("keeps partial evidence when there is some", () => {
    const unknown = createResidualUnknown({
      id: id("a"),
      question: "q",
      reason: "resource_limit",
      partialEvidence: ["exc_0000000000000000000000"],
    });
    expect(unknown.partial_evidence).toEqual(["exc_0000000000000000000000"]);
  });

  it("refuses an empty question, which would record nothing", () => {
    expect(() =>
      createResidualUnknown({ id: id("a"), question: "", reason: "not_attempted" }),
    ).toThrow();
  });

  it("refuses an id that does not carry the `unk_` prefix", () => {
    expect(() =>
      createResidualUnknown({
        id: "ev_0000000000000000000000",
        question: "q",
        reason: "out_of_scope",
      }),
    ).toThrow();
  });

  it("produces a value that satisfies the published schema", () => {
    const unknown = createResidualUnknown({ id: id("a"), question: "q", reason: "cancelled" });
    expect(residualUnknownSchema.safeParse(unknown).success).toBe(true);
  });
});

describe("the unknown id grammar", () => {
  const hex22 = "0123456789abcdef012345";
  const accepts = (unknownId: string) =>
    residualUnknownSchema.safeParse({
      unknown_id: unknownId,
      question: "q",
      reason: "not_attempted",
    }).success;

  // An id is two interchangeable facts — the `unk_` prefix that marks an
  // unknown, and the 22 hex digits that identify one. A regex that stops
  // anchoring either end accepts an id that is not the contract's: a length
  // that does not exist, trailing junk after the digits, or an `unk_` buried
  // inside another prefix. The rows below are the boundaries on both sides.
  it.each([
    ["the prefixed 22 hex digits the contract mints", `unk_${hex22}`, true],
    ["21 hex digits, one short of the contract", `unk_${hex22.slice(0, 21)}`, false],
    ["23 hex digits, one past the contract", `unk_${hex22}0`, false],
    ["trailing characters after the digits", `unk_${hex22}-extra`, false],
    ["an `unk_` that does not start the id", `xunk_${hex22}`, false],
    ["a different prefix of the right shape", `ev_${hex22}`, false],
    ["uppercase hex digits, which the contract does not mint", `unk_${hex22.toUpperCase()}`, false],
  ])("%s", (_label, unknownId, accepted) => {
    expect(accepts(unknownId)).toBe(accepted);
  });
});

describe("sortUnknowns", () => {
  const unknown = (suffix: string) =>
    createResidualUnknown({ id: id(suffix), question: `q${suffix}`, reason: "not_attempted" });

  it("orders by id, which is what makes a bundle byte-stable", () => {
    const sorted = sortUnknowns([unknown("c"), unknown("a"), unknown("b")]);
    expect(sorted.map((entry) => entry.unknown_id)).toEqual([id("a"), id("b"), id("c")]);
  });

  it("leaves the input array alone", () => {
    const input = [unknown("b"), unknown("a")];
    sortUnknowns(input);
    expect(input.map((entry) => entry.unknown_id)).toEqual([id("b"), id("a")]);
  });

  it("is a total order, so no pair compares equal", () => {
    const left = unknown("a");
    const right = unknown("b");
    expect(compareUnknowns(left, right)).toBeLessThan(0);
    expect(compareUnknowns(right, left)).toBeGreaterThan(0);
    expect(compareUnknowns(left, left)).toBe(0);
  });

  it("handles the empty and single-element cases", () => {
    expect(sortUnknowns([])).toEqual([]);
    expect(sortUnknowns([unknown("a")])).toHaveLength(1);
  });
});
