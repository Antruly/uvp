/**
 * The native HTTP/3 probe.
 *
 * `uvp_http_request` answers HTTP/1.1 and HTTP/2 from Node. Neither of those is
 * HTTP/3, and Node's standard library has no HTTP/3 client at all — so without
 * this, `http_version: "3"` could only ever be refused. That was the honest answer
 * while nothing could ask the question; it is no longer the only one, because
 * libuvcpp's C ABI has an h3 client, and the stack that has it is the stack uvp
 * generates services against.
 *
 * This is that client, as a port. It reaches the same `native/uvcpp-probe`
 * process as the WebSocket probe, with `exchange: "http3"`, and the boundary it
 * presents is the one thing the C ABI can actually report:
 *
 *   - **The response headers it asked for, by name.** The C ABI reads one header
 *     at a time (`uvcpp_c_h3_response_header`) and has no header-list call, so a
 *     complete header set is not something this stack can produce at any price.
 *     The names it looks for are in every report, so a short list reads as "these
 *     were looked for and these were found" rather than as a complete set.
 *   - **No certificate.** The QUIC client verifies against a CA bundle it is
 *     handed or not at all — there is no system-trust-store path in this layer —
 *     so a report says whether it verified rather than claiming a chain it never
 *     examined.
 *   - **No timings below the poll interval.** The h3 connection has no ready
 *     callback, so the probe polls at 2 ms; the report says so.
 *
 * Everything here is shaped so those absences travel as absences. Nothing fills a
 * gap with a plausible value.
 *
 * Implementations live in the toolchain layer. This file is the boundary: the
 * types a caller may rely on, and the outcomes an implementation must produce.
 */

import type { NativeProbeExchange, NativeProbeExchangeOutcome } from "./nativeProbe.js";

/** One request header, as the caller supplies it. */
export interface NativeHttp3Header {
  readonly name: string;
  readonly value: string;
}

/** What one run observed. Facts and only facts. */
export interface NativeHttp3Report {
  /** The URL as the caller gave it, carried for the record. */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly authority: string;
  /**
   * Whether the QUIC client was given a CA bundle to verify against.
   *
   * False means nothing was enforced, which is not the same as "the chain
   * validated" — see `tlsVerification` below for what a caller should read.
   */
  readonly verifyPeer: boolean;
  /** True when the QUIC handshake completed. */
  readonly handshakeCompleted: boolean;
  readonly handshakeOk: boolean;
  /** The transport's own status for the handshake; 0 when it succeeded. */
  readonly handshakeStatus: number;
  /**
   * The ALPN the handshake negotiated: `"h3"` for HTTP/3.
   *
   * Reported as the string it is rather than as a boolean, because it is the
   * observation that says the far end agreed to speak HTTP/3 — a request that
   * went out over a connection negotiated as something else would otherwise be
   * indistinguishable in this report.
   */
  readonly alpn: string;
  readonly requestSent: boolean;
  /**
   * The stream the request went out on, or `undefined` when none did.
   *
   * Absent rather than `0` when nothing was sent, because stream zero is the first
   * client-initiated stream and is a perfectly ordinary value: a caller has to be
   * able to tell "no stream" from "stream zero".
   */
  readonly streamId: number | undefined;
  /** How many times a request was attempted; more than one means it was retried. */
  readonly sendAttempts: number;
  /**
   * The last negative code the send returned, when it never succeeded.
   *
   * A number, not a name: two of those codes are ordinary results on this stack
   * (the critical streams are not open yet; the peer has not granted a stream) and
   * telling them apart would mean this layer reading ngtcp2's private headers.
   */
  readonly lastSendError: number | undefined;
  /** True when a completed response was taken from the session. */
  readonly answered: boolean;
  /** The status code, or `undefined` when no response head ever arrived. */
  readonly status: number | undefined;
  /**
   * The request's own ending: 0 normal, non-zero it never finished cleanly.
   *
   * Distinct from `error`, which is the transport's. A response head that arrived
   * with a non-zero `responseError` is a response that was cut short, and the two
   * together are what say so.
   */
  readonly responseError: number;
  /**
   * The response headers that were found, by name.
   *
   * Not a list, and the difference is the stack's rather than a choice: the C ABI
   * reads one response header at a time by name and has no header-list call, so
   * neither the wire order nor a repeated header is reachable here. A name that is
   * absent was either not sent or not asked for, and `headersObserved` is what
   * tells those apart.
   */
  readonly headers: Readonly<Record<string, string>>;
  /** The header names the probe asked for; anything not here was not looked at. */
  readonly headersObserved: readonly string[];
  readonly body: string;
  /** The body's real length, whether or not the body was kept. */
  readonly bodyBytes: number;
  /** Why the body is absent, when it is. Present only when it is. */
  readonly bodyOmitted: string | undefined;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly disconnected: boolean;
  readonly error: { readonly what: string; readonly code: number } | undefined;
  /**
   * Why the run ended: `"answered"` when the response arrived, `"idle"` when
   * nothing happened for the idle timeout, `"total"` at the whole-run ceiling.
   */
  readonly stopReason: "answered" | "idle" | "total" | undefined;
  readonly abandoned: boolean;
  readonly totalMs: number;
  readonly notObservable: readonly string[];
  readonly libraryVersion: string | undefined;
}

/** One probe run, as the caller asks for it. */
export interface NativeHttp3Request {
  /** The URL as given, for the report. The fields below are what is used. */
  readonly url: string;
  /**
   * The host and port, named rather than parsed from the URL.
   *
   * uvp's own URI parser owns "what this URL means", and the probe is given the
   * facts that parser produced instead of being handed a string to interpret a
   * second time.
   */
  readonly host: string;
  readonly port: number;
  readonly path: string;
  /** The `:authority` pseudo-header; defaults to `host:port` in the probe. */
  readonly authority: string | undefined;
  readonly method: string;
  readonly headers: readonly NativeHttp3Header[];
  /**
   * The body as text, for a probe that predates `bodyBase64`.
   *
   * The probe protocol carries JSON strings, and a byte that is not valid UTF-8
   * cannot survive one. `bodyBase64` is the lossless field, and the probe prefers
   * it; this one remains so an older probe at `UVP_NATIVE_PROBE` still receives
   * the text bodies it can carry rather than nothing.
   */
  readonly body: string;
  /**
   * The body as the exact bytes the caller supplied, base64-encoded.
   *
   * Absent when there is no body. A probe that understands this field ignores
   * `body`; the two are the same bytes for a UTF-8 body, and only this one is the
   * same bytes for every other body.
   */
  readonly bodyBase64: string | undefined;
  /** A PEM bundle to verify the peer against. Absent means no verification. */
  readonly caFile: string | undefined;
  /** End the run after this long with nothing happening on the connection. */
  readonly idleTimeoutMs: number;
  /** The ceiling for the whole run, which the probe enforces as a backstop. */
  readonly totalTimeoutMs: number;
  /** The most body bytes kept; a larger body is reported as omitted, not cut. */
  readonly maxBodyBytes: number;
}

export type NativeHttp3Outcome = NativeProbeExchangeOutcome<NativeHttp3Report>;

/** The probe, as `uvp_http_request` uses it. */
export type NativeHttp3Probe = NativeProbeExchange<NativeHttp3Request, NativeHttp3Report>;
