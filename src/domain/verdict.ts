import { z } from "zod";

/**
 * The three answers a check can give.
 *
 * Two states were not enough, and every collapse of the third into a boolean has
 * cost the same thing: "I looked and it was not there" and "I could not look"
 * are different findings. A feature whose presence would be read out of a
 * configuration header that does not exist, an assertion whose exchange never
 * completed, and a toolchain whose probe was never wired up all land in the
 * third state, and each says why in its own `note` or `message`.
 *
 * Declared here rather than at each site because the same word answers the same
 * question in four places: `uvp_doctor`'s feature verdicts, `uvp_assert_exchange`'s
 * result rows, the assertion engine that produces the latter, and the CLI that
 * renders both. A result row and a capability answer to the same question must
 * not spell their third state two ways.
 */
export const verdictStatusSchema = z.enum(["satisfied", "unmet", "undetermined"]);

export type VerdictStatus = z.infer<typeof verdictStatusSchema>;

/**
 * A verdict's negation.
 *
 * `undetermined` negates to itself. A check that could not be read is not
 * satisfied by being unsatisfied — negating an unevaluable assertion leaves it
 * unevaluable, which is what keeps `--assert '!body_contains=ready'` from
 * passing on a request that never returned a body.
 */
export const negateVerdict = (status: VerdictStatus): VerdictStatus =>
  status === "satisfied" ? "unmet" : status === "unmet" ? "satisfied" : "undetermined";

export interface VerdictTally {
  readonly satisfied: number;
  readonly unmet: number;
  readonly undetermined: number;
}

/**
 * Count verdicts.
 *
 * The three counts come from one pass over the same list, so a caller can rely
 * on `satisfied + unmet + undetermined` being the number of checks there were —
 * which is the arithmetic that keeps a check nobody could evaluate from leaving
 * the totals or, worse, being counted as one that passed.
 */
export const tallyVerdicts = (statuses: readonly VerdictStatus[]): VerdictTally => {
  const tally = { satisfied: 0, unmet: 0, undetermined: 0 };
  for (const status of statuses) tally[status] += 1;
  return tally;
};
