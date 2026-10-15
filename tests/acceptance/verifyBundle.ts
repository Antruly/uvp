/**
 * Reading a `uvp verify` bundle from a test.
 *
 * The bundle is the product's answer, so every test in this lane reads the same
 * few fields out of it, and the two things worth getting right are worth getting
 * right once:
 *
 * - **A missing array is a failure, not an empty one.** `result["exchanges"]
 *   ?? []` would turn "the bundle has no exchanges field" into "the pass made no
 *   requests" — the two look the same to a test and mean opposite things.
 * - **Counts without names are not enough.** `onlyExchange` asserts there is
 *   exactly one exchange, so a pass that made two requests cannot satisfy a test
 *   written about one.
 */

export interface Exchange {
  readonly name?: unknown;
  readonly status?: unknown;
  /** The version the response arrived in, as the wire spells it. */
  readonly http_version?: unknown;
  readonly elapsed_ms?: unknown;
  readonly assertions_passed?: unknown;
  readonly assertions_failed?: unknown;
  readonly failures?: unknown;
}

export interface Observation {
  readonly kind?: unknown;
  /** `note` is what a coverage entry carries when it is not complete. */
  readonly coverage?: { readonly status?: unknown; readonly note?: unknown };
}

/** A field of the bundle, or a failure quoting what arrived instead. */
export const listOf = <T>(result: Record<string, unknown>, field: string): readonly T[] => {
  const value = result[field];
  if (!Array.isArray(value)) {
    throw new Error(`no ${field} array in the bundle: ${JSON.stringify(result).slice(0, 400)}`);
  }
  return value as readonly T[];
};

/** The single exchange of a one-request pass. */
export const onlyExchange = (result: Record<string, unknown>): Exchange => {
  const exchanges = listOf<Exchange>(result, "exchanges");
  if (exchanges.length !== 1) {
    throw new Error(`expected one exchange, found ${String(exchanges.length)}`);
  }
  return exchanges[0] ?? {};
};
