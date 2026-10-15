/**
 * The native WebSocket probe.
 *
 * `uvp_websocket_probe` can answer on two stacks. The default is the Node client
 * in `websocketClient.ts`, which speaks RFC 6455 itself and can report the
 * handshake status line and every header. The other is libuvcpp's own WebSocket
 * client, reached through its C ABI — the stack a generated service actually
 * links against, which is why a caller debugging one wants to probe the other
 * with it.
 *
 * The two are not interchangeable and this port does not pretend they are. The C
 * ABI hands back a narrower set of facts: no status line, no headers, no ping or
 * pong, no subprotocol, and a failed handshake reported as a transport status
 * rather than as an HTTP response. Everything here is shaped so those absences
 * travel as absences: a report says what the stack observed and carries the list
 * of what it could not observe, and nothing fills a gap with a plausible value.
 *
 * The probe itself is a **separate process** — `native/uvcpp-probe`, built
 * against a libuvcpp install by `npm run build:native-probe`. It has to be: the
 * C ABI's client owns its event loop and offers no way to run it inside someone
 * else's, and a probe that could not be interrupted would be a probe that hangs
 * a tool call. The process boundary is also what makes the probe's own limits
 * survivable — a run whose loop cannot be woken is reported as abandoned rather
 * than quietly losing whatever came after the last frame.
 *
 * Implementations live in the toolchain layer. This file is the boundary: the
 * types a caller may rely on, and the outcomes an implementation must produce.
 */

/** One frame the native stack observed, with the payload as far as it could read it. */
export interface NativeProbeFrame {
  readonly direction: "sent" | "received";
  readonly opcode: "text" | "binary";
  /** The length of the whole frame, which is not the length of a truncated payload. */
  readonly bytes: number;
  readonly atMs: number;
  readonly truncated: boolean;
  /** Present when the payload is text the stack could hand over whole. */
  readonly text?: string;
  /** Present for a binary frame: the payload, so a caller can read it. */
  readonly base64?: string;
  /**
   * Why `text` is absent on a text frame.
   *
   * `truncated` means the payload was longer than the probe's per-frame limit,
   * and the probe refuses to decode a prefix that may end mid-character — a
   * replacement character would be a byte the peer never sent. `invalid-utf8`
   * means the payload is not UTF-8 at all, which is a protocol violation by the
   * peer and is reported as one.
   */
  readonly textOmitted?: "truncated" | "invalid-utf8";
}

/** The end of a connection, as the stack reported it. */
export interface NativeProbeClose {
  /** The code the stack reported; see `closeCodes.ts` for what each value means. */
  readonly code: number;
  readonly reason: string;
  /**
   * True when the code says a Close **frame** arrived, rather than the connection
   * simply ending. Derived from the code, because the C ABI reports the ending and
   * not the frame that caused it.
   */
  readonly closeFrameReceived: boolean;
}

/**
 * What one run observed.
 *
 * Facts and only facts: nothing here is named after a tool field, so a mapping
 * that turns these into `uvp_websocket_probe`'s output can be read on its own and
 * disagreed with.
 */
export interface NativeProbeReport {
  readonly url: string;
  /** True when the stack completed an upgrade. It never sees the status line, so
   * this is the handshake's whole outcome as far as the C ABI is concerned. */
  readonly upgraded: boolean;
  readonly frames: readonly NativeProbeFrame[];
  /** Frames the peer sent, counted before the frame log was capped. */
  readonly framesReceived: number;
  /** Frames dropped because the frame log was full. Counted, never silent. */
  readonly framesWithheld: number;
  readonly peerClosed: boolean;
  readonly close: NativeProbeClose | undefined;
  /** True when the probe sent a Close frame of its own — only the frame cap does that. */
  readonly closeSentByProbe: boolean;
  readonly error: { readonly what: string; readonly code: number } | undefined;
  /** Which deadline ended the run. `undefined` when a callback stopped it. */
  readonly stopReason: "idle" | "total" | undefined;
  /**
   * True when the report was written without the client loop ever returning.
   *
   * The C ABI's client loop cannot be woken from another thread, so a run that a
   * deadline ends is reported out from under a loop still parked in `poll`. On
   * this stack that is the ordinary ending rather than an exceptional one — it is
   * what happens whenever the peer leaves the connection idle — and everything the
   * peer sent after the last recorded frame is unknown rather than absent.
   */
  readonly abandoned: boolean;
  readonly totalMs: number;
  /** What this stack cannot observe at all, in this stack's own words. */
  readonly notObservable: readonly string[];
  /**
   * `run()`'s return value, reported and never interpreted: the C ABI documents
   * no meaning for it. Present only when it was non-zero.
   */
  readonly loopReturn: number | undefined;
  readonly libraryVersion: string | undefined;
}

/**
 * Whether the native stack can be used here, in three states.
 *
 * The third state is the point. A probe binary that is not on this host is
 * *unavailable*; a probe binary that is there but did not answer is *undetermined*,
 * because a check that could not run has not established anything about it. A
 * caller that collapses the two reports either "you have no probe" about a probe
 * that exists, or "the probe works" about one that never answered.
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

/** One probe run, as the caller asks for it. */
export interface NativeProbeRequest {
  readonly url: string;
  readonly send: readonly {
    readonly payload: string;
    readonly encoding: "utf8" | "base64";
    readonly waitMs: number;
  }[];
  /** Stop after the stack has received this many frames. */
  readonly maxFrames: number;
  /** The most payload bytes kept for one frame; the rest is reported as truncated. */
  readonly maxFrameBytes: number;
  /** End the run after this long with nothing happening on the connection. */
  readonly idleTimeoutMs: number;
  /**
   * The ceiling for the whole run, which the probe enforces as a backstop.
   *
   * Not the caller's deadline: a chatty peer keeps the connection busy, so the
   * probe ends on the frame cap or the idle timeout first and this only fires
   * when something is stuck.
   */
  readonly totalTimeoutMs: number;
}

/**
 * How a run ended — including the ways it did not.
 *
 * No throws, and not because throwing is inconvenient: each of these is a
 * different fact with a different remedy, and an exception would flatten
 * "this host has no probe" into the same channel as "the far end answered
 * nothing". The service layer decides what each one is worth to the caller.
 */
export type NativeProbeOutcome =
  | { readonly kind: "report"; readonly report: NativeProbeReport }
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

export interface NativeWebSocketProbe {
  /** Whether the stack can be used here, without connecting to anything. */
  availability(signal: AbortSignal): Promise<NativeProbeAvailability>;
  probe(request: NativeProbeRequest, signal: AbortSignal): Promise<NativeProbeOutcome>;
}
