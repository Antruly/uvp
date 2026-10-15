import { describe, expect, it } from "vitest";

import { PROVIDER_OBLIGATIONS } from "./providerContract.js";
import { PROVIDER_FAULTS, fakeSubject } from "./providerSubjects.js";

/**
 * Every obligation, run against a provider built to break it.
 *
 * A conformance suite is worth what its checks are worth, and a check nobody has
 * seen fail is worth a comment. The rest of this repository answers that by
 * reverting a fix and watching the test go red; here the broken thing is a
 * fixture, so the proof is permanent and re-run on every commit instead of being
 * a sentence in a commit message.
 *
 * Two things are required of each fault, and the second is the one that is easy
 * to skip:
 *
 *   - The obligation it names must reject it, or the check does not exist.
 *   - **Every other** obligation must accept it. A fault that trips several
 *     checks leaves it ambiguous which one caught it, and ambiguity accumulates
 *     quietly: a suite full of checks that all fire on everything looks thorough
 *     and localises nothing. Keeping each fault to exactly one failure is what
 *     makes "this check is the reason this run went red" a true sentence.
 */

describe("the provider obligations, against a provider built to break one", () => {
  it("has a fault for every obligation, so none of them is unproven", () => {
    const broken = new Set(PROVIDER_FAULTS.map((fault) => fault.obligation.id));
    const unproven = PROVIDER_OBLIGATIONS.filter((obligation) => !broken.has(obligation.id)).map(
      (obligation) => obligation.id,
    );
    expect(
      unproven,
      "obligations that no fault fixture breaks, so nothing shows they can fail",
    ).toEqual([]);
  });

  it("accepts the conforming provider, so a rejection below means the fault and not the check", async () => {
    // Without this, `rejects` in the tests below would be satisfied by an
    // obligation that rejects everything — a check that is wrong about the
    // contract in the other direction, and indistinguishable from a good one
    // when the only subject it is ever handed is broken.
    const conforming = fakeSubject({ name: "the conforming provider" });
    for (const obligation of PROVIDER_OBLIGATIONS) {
      await expect(
        obligation.check(conforming),
        `"${obligation.id}" rejected a conforming provider`,
      ).resolves.toBeUndefined();
    }
  });

  for (const fault of PROVIDER_FAULTS) {
    it(`catches ${fault.subject.name}`, async () => {
      await expect(fault.obligation.check(fault.subject)).rejects.toThrow();

      for (const other of PROVIDER_OBLIGATIONS) {
        if (other.id === fault.obligation.id) continue;
        await expect(
          other.check(fault.subject),
          `"${other.id}" also rejected ${fault.subject.name}, so which obligation caught it is ambiguous`,
        ).resolves.toBeUndefined();
      }
    });
  }
});
