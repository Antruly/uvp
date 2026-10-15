/**
 * What every native probe's boundary has in common.
 *
 * uvp has two native probes now, and they are the same shape: a C++ program built
 * against libuvcpp, run as a child process because the C ABI's clients own their
 * event loops and offer no way to run one inside someone else's. They differ in
 * the exchange — `NativeWebSocketProbe` and `NativeHttp3Probe` — and in nothing
 * else about how they are reached.
 *
 * The two things here are the ones both need and neither owns:
 *
 *   - **Availability, in three states.** A probe binary that is not on this host
 *     is *unavailable*; one that is there but did not answer is *undetermined*,
 *     because a check that could not run has not established anything. A caller
 *     that collapses the two reports either "you have no probe" about a probe that
 *     exists, or "the probe works" about one that never answered.
 *   - **How a run ended, including the ways it did not.** No throws, and not
 *     because throwing is inconvenient: each of these is a different fact with a
 *     different remedy, and an exception would flatten "this host has no probe"
 *     into the same channel as "the far end answered nothing".
 *
 * Both are generic in the report type and nothing else, because the report is the
 * one part that is genuinely per-exchange. The types are here rather than beside
 * either probe so that a caller can read the vocabulary of "can this be run, and
 * how did it end" without reading either exchange's fields.
 */

/**
 * Whether the native stack can be used here, in three states.
 *
 * The third state is the point: see the note above.
 */
export type NativeProbeAvailability =
  | {
      readonly state: "available";
      readonly path: string;
      /** The libuvcpp version the probe loaded, when it reported one. */
      readonly libraryVersion: string | undefined;
    }
  | {
      readonly state: "unavailable";
      readonly reason: string;
      /** Absent when no candidate path existed to examine. */
      readonly path?: string | undefined;
    }
  | { readonly state: "undetermined"; readonly reason: string; readonly path: string };

/**
 * How one probe run ended.
 *
 * `Report` is the exchange's own report type — what this stack observed, as facts.
 */
export type NativeProbeExchangeOutcome<Report> =
  | { readonly kind: "report"; readonly report: Report }
  /** The stack is not usable here. `state` carries the distinction above. */
  | {
      readonly kind: "stack-unavailable";
      readonly state: "unavailable" | "undetermined";
      readonly reason: string;
      readonly path?: string | undefined;
    }
  /** The probe refused the request, and says why. Its message is the reason. */
  | { readonly kind: "request-refused"; readonly message: string }
  /** The caller cancelled the run; the probe was killed and observed nothing more. */
  | { readonly kind: "cancelled" }
  /**
   * The probe ran and produced nothing usable. A fact about the probe, not about
   * the target: `detail` is what it managed to say.
   */
  | { readonly kind: "probe-failed"; readonly message: string; readonly detail: string };

/**
 * One native probe, as a caller uses it.
 *
 * `Request` is how the caller asks, which is per-exchange for the same reason the
 * report is.
 */
export interface NativeProbeExchange<Request, Report> {
  /** Whether the stack can be used here, without connecting to anything. */
  availability(signal: AbortSignal): Promise<NativeProbeAvailability>;
  probe(request: Request, signal: AbortSignal): Promise<NativeProbeExchangeOutcome<Report>>;
}
