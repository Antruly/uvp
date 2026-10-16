import { describe, expect, it } from "vitest";

import { createEvidence, evidenceDigest, evidenceRef } from "./evidence.js";
import { newId } from "./identity.js";

/**
 * Evidence is the unit of delivery, and the two claims that carry the weight are
 * that `observed` and `derived` stay separate and that a digest identifies a
 * claim rather than a run. If the digest moved between runs, "is this still
 * true?" would be unanswerable and the whole model would be decoration.
 */

const evidenceOf = (overrides: Partial<Parameters<typeof createEvidence>[0]> = {}) =>
  createEvidence({
    kind: "build",
    subject: { workspace: "wsp_x", target: "svc" },
    observedAt: "2026-10-15T00:00:00.000Z",
    observed: { exit_code: 0 },
    derived: { succeeded: true },
    coverage: { scope: "the declared target", status: "complete" },
    sources: [{ kind: "command", ref: "cmake --build build" }],
    ...overrides,
  });

describe("createEvidence", () => {
  it("mints its own id when given none", () => {
    expect(evidenceOf().evidence_id).toMatch(/^ev_[0-9a-f]{22}$/u);
  });

  it("accepts an injected id and clock, so a record is reproducible", () => {
    const evidence = evidenceOf({ id: "ev_0000000000000000000000" });
    expect(evidence.evidence_id).toBe("ev_0000000000000000000000");
    expect(evidence.observed_at).toBe("2026-10-15T00:00:00.000Z");
  });

  it("defaults the two optional collections to empty rather than absent", () => {
    const evidence = evidenceOf();
    expect(evidence.derived).toEqual({ succeeded: true });
    expect(evidence.limitations).toEqual([]);
  });

  it("keeps observed and derived in separate fields", () => {
    // Not a stylistic point: a caller auditing a verdict reads `derived` and
    // checks it against `observed`. Merging them destroys that.
    const evidence = evidenceOf();
    expect(evidence.observed).toEqual({ exit_code: 0 });
    expect(evidence.derived).toEqual({ succeeded: true });
    expect(Object.keys(evidence.observed)).not.toContain("succeeded");
  });

  it("copies the arrays it was handed", () => {
    const limitations = ["the toolchain was not exercised"];
    const evidence = evidenceOf({ limitations });
    limitations.push("added after the fact");
    expect(evidence.limitations).toEqual(["the toolchain was not exercised"]);
  });

  it("refuses coverage with no scope", () => {
    expect(() => evidenceOf({ coverage: { scope: "", status: "complete" } })).toThrow();
  });
});

describe("evidenceDigest", () => {
  it("is the same for the same claim about the same subject", () => {
    expect(evidenceDigest(evidenceOf())).toBe(evidenceDigest(evidenceOf()));
  });

  it("ignores the id and the timestamp, which are about the run and not the claim", () => {
    const first = evidenceOf({ id: newId("evidence"), observedAt: "2026-01-01T00:00:00.000Z" });
    const second = evidenceOf({ id: newId("evidence"), observedAt: "2026-09-09T09:09:09.000Z" });
    expect(evidenceDigest(first)).toBe(evidenceDigest(second));
  });

  it("moves when an observation changes", () => {
    expect(evidenceDigest(evidenceOf({ observed: { exit_code: 0 } }))).not.toBe(
      evidenceDigest(evidenceOf({ observed: { exit_code: 1 } })),
    );
  });

  it("moves when only the coverage changes", () => {
    // Coverage is part of the claim. Two records that saw different amounts of
    // the subject are not the same evidence.
    expect(
      evidenceDigest(
        evidenceOf({ coverage: { scope: "the declared target", status: "complete" } }),
      ),
    ).not.toBe(
      evidenceDigest(evidenceOf({ coverage: { scope: "the declared target", status: "partial" } })),
    );
  });

  it("does not move when only a limitation changes", () => {
    // `limitations` is advisory prose about the record; the material part of
    // "how much did we see" lives in `coverage`, and a truncation also shows up
    // in `observed`. Identity follows the claim, not the commentary.
    expect(evidenceDigest(evidenceOf({ limitations: ["output was truncated"] }))).toBe(
      evidenceDigest(evidenceOf()),
    );
  });

  it("is order-independent across the keys of a free-form field", () => {
    expect(evidenceDigest(evidenceOf({ observed: { a: 1, b: 2 } }))).toBe(
      evidenceDigest(evidenceOf({ observed: { b: 2, a: 1 } })),
    );
  });
});

describe("evidenceRef", () => {
  it("pairs the id with a short digest, so a log line is checkable", () => {
    const evidence = evidenceOf();
    expect(evidenceRef(evidence)).toBe(
      `${evidence.evidence_id}@${evidenceDigest(evidence).slice(0, 16)}`,
    );
  });

  it("carries the digest of the claim, not a digest of the id", () => {
    const evidence = evidenceOf();
    const changed = evidenceOf({ observed: { exit_code: 1 } });
    // Same id, different claim: the reference has to differ, or a stale
    // reference would look current.
    expect(evidenceRef({ ...evidence, observed: changed.observed })).not.toBe(
      evidenceRef(evidence),
    );
  });
});
