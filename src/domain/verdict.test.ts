import { describe, expect, it } from "vitest";

import { negateVerdict, tallyVerdicts, verdictStatusSchema } from "./verdict.js";

describe("negateVerdict", () => {
  it("swaps satisfied and unmet", () => {
    expect(negateVerdict("satisfied")).toBe("unmet");
    expect(negateVerdict("unmet")).toBe("satisfied");
  });

  it("leaves undetermined alone", () => {
    // The whole reason this is a function and not a ternary at the call site: a
    // check nobody could evaluate has no verdict to invert, and answering
    // "satisfied" there is the one outcome that claims the most while resting
    // on nothing.
    expect(negateVerdict("undetermined")).toBe("undetermined");
  });

  it("is its own inverse on every status", () => {
    for (const status of verdictStatusSchema.options) {
      expect(negateVerdict(negateVerdict(status))).toBe(status);
    }
  });
});

describe("tallyVerdicts", () => {
  it("counts the three states and nothing else", () => {
    expect(
      tallyVerdicts(["satisfied", "unmet", "undetermined", "satisfied", "undetermined"]),
    ).toEqual({ satisfied: 2, unmet: 1, undetermined: 2 });
  });

  it("accounts for every status it was given", () => {
    // The arithmetic a caller relies on: a check nobody could evaluate stays in
    // the total rather than vanishing from it, which is how it would read as an
    // assertion that was never asked.
    const statuses = ["satisfied", "unmet", "undetermined", "undetermined"] as const;
    const tally = tallyVerdicts(statuses);
    expect(tally.satisfied + tally.unmet + tally.undetermined).toBe(statuses.length);
  });

  it("is all zeroes for no checks at all", () => {
    expect(tallyVerdicts([])).toEqual({ satisfied: 0, unmet: 0, undetermined: 0 });
  });
});
