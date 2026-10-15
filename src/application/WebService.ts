import { Buffer } from "node:buffer";

import { cancelledFailure, UvpFailure } from "../domain/errors.js";
import { newId, sha256 } from "../domain/identity.js";
import {
  decodeBody,
  performRequest,
  transportFailureKind,
  TransportFailure,
} from "./httpClient.js";
import type { HttpExchange, HttpTiming } from "./httpClient.js";
import type { NativeHttp3Probe } from "./NativeHttp3Probe.js";
import { evaluateAssertions, percentile } from "./assertions.js";
import type { AssertionSpec } from "./assertions.js";
import type { EvidenceRecorder } from "./evidenceHelpers.js";
import { Http3Client } from "./Http3Client.js";
import { rememberExchange } from "./exchangeRecord.js";
import type { HttpRequestOutput, TimingOutput, ToolTlsReport } from "./httpToolOutput.js";
import {
  coverageComplete,
  coveragePartial,
  endpointSource,
  record,
  recordUnknown,
} from "./evidenceHelpers.js";
import { framePayload, probeWebSocket } from "./websocketClient.js";
import type { WebSocketFrame, WebSocketOpcode } from "./websocketClient.js";
import type {
  NativeProbeFrame,
  NativeProbeOutcome,
  NativeWebSocketProbe,
} from "./NativeWebSocketProbe.js";
import type { SessionStore } from "./sessionStore.js";

/**
 * The web-testing surface.
 *
 * These are the tools a developer reaches for when a service is running but not
 * behaving, and they share one rule: report what the peer actually said. The
 * negotiated protocol version, the TLS peer, the exact bytes, how long each
 * phase took, and — when something failed — which of the failure modes it was.
 *
 * Two asymmetries in the contracts are deliberate and are honoured here rather
 * than smoothed over:
 *
 *   - `uvp_http_request` treats an unreachable endpoint as an error, because
 *     there is no exchange to describe. `uvp_soap_call` treats it as a result
 *     (`transport_error`), because a SOAP caller is asking about an operation
 *     and "the transport never got there" is one of its outcomes.
 *   - Nothing here fabricates a status. A request that never completed has no
 *     status, and the tools that can express that say so instead of reporting 0.
 */

export interface WebServiceOptions {
  readonly store: SessionStore;
  readonly now?: (() => Date) | undefined;
  readonly maxBodyBytes?: number | undefined;
  /**
   * The libuvcpp stack's probe, for `uvp_websocket_probe` with `stack: "libuvcpp"`.
   *
   * Optional because a caller that only ever probes with the default stack should
   * not have to supply one, and because the toolchain layer is allowed to be
   * absent — a host without the probe binary is `toolchain_unavailable`, which is
   * an answer, not a construction failure.
   */
  readonly nativeProbe?: NativeWebSocketProbe | undefined;
  /**
   * The same binary's HTTP/3 exchange, for `uvp_http_request` with
   * `http_version: "3"`.
   *
   * Separate from `nativeProbe` rather than one object with two methods, because
   * the two disagree about what a usable build is: a probe predating the exchange
   * list speaks WebSocket and not h3. A caller with one and not the other should be
   * able to say so, and a lane that scripts one exchange's report should not have
   * to satisfy the other's.
   */
  readonly nativeHttp3Probe?: NativeHttp3Probe | undefined;
}

const MS_CAP = 60 * 60 * 1000;

const toTiming = (timing: HttpTiming): TimingOutput => ({
  ...(timing.dnsMs === undefined ? {} : { dns_ms: timing.dnsMs }),
  ...(timing.connectMs === undefined ? {} : { connect_ms: timing.connectMs }),
  ...(timing.tlsMs === undefined ? {} : { tls_ms: timing.tlsMs }),
  ...(timing.ttfbMs === undefined ? {} : { ttfb_ms: timing.ttfbMs }),
  total_ms: timing.totalMs,
});

/**
 * The certificate report, as a caller reads it.
 *
 * Re-exported from the shared output module so that the importers of this file —
 * the verification service among them — keep one import for "the web service and
 * the shapes it returns" rather than reaching into where the shape is declared.
 */
export type { ToolTlsReport } from "./httpToolOutput.js";

const toTls = (exchange: HttpExchange): ToolTlsReport | undefined => {
  const tls = exchange.tls;
  if (tls === undefined) return undefined;
  return {
    ...(tls.protocol === undefined ? {} : { protocol: tls.protocol }),
    ...(tls.cipher === undefined ? {} : { cipher: tls.cipher }),
    ...(tls.subject === undefined ? {} : { subject: tls.subject }),
    ...(tls.issuer === undefined ? {} : { issuer: tls.issuer }),
    ...(tls.validFrom === undefined ? {} : { valid_from: tls.validFrom }),
    ...(tls.validTo === undefined ? {} : { valid_to: tls.validTo }),
    verification: tls.verification,
    ...(tls.reason === undefined ? {} : { reason: tls.reason }),
  };
};

/**
 * Record an exchange in the session, so `uvp_assert_exchange` can re-evaluate it.
 *
 * The one recording path, in `exchangeRecord.ts`, because it is shared with the
 * HTTP/3 client — which records a narrower header set and has to say so.
 */
const remember = rememberExchange;

export interface HttpRequestInput {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly body_encoding: "utf8" | "base64";
  readonly http_version: "auto" | "1.1" | "2" | "3";
  readonly follow_redirects: boolean;
  readonly max_redirects: number;
  readonly verify_tls: boolean;
  readonly timeout_ms: number;
  readonly max_body_bytes: number;
}

/**
 * The most payload bytes one frame carries back to a caller.
 *
 * The same number on both stacks: the Node client cuts a payload here, and the
 * probe process is told to cut one here, so a caller comparing two runs is
 * comparing the far end rather than the client.
 */
const FRAME_PAYLOAD_BYTES = 64 * 1024;

/**
 * How far past the idle timeout the native probe's own ceiling sits.
 *
 * The probe ends on the frame cap or the idle timeout in every ordinary run, so
 * this is a backstop for a connection that keeps the loop busy without ever
 * producing the frames the caller asked for. It is derived here rather than
 * exposed as a second timeout the caller has to think about.
 */
const NATIVE_TOTAL_TIMEOUT_SLACK_MS = 5_000;

/**
 * One observed frame, in the shape both stacks can be normalized to.
 *
 * `payload` is absent when a stack would not hand the bytes over, which is a
 * different thing from an empty payload: the only honest rendering of "the frame
 * was longer than the limit" or "it is not text" is to carry no payload and say
 * which of the two it was.
 */
interface ProbeFrame {
  readonly direction: "sent" | "received";
  readonly opcode: WebSocketOpcode;
  readonly bytes: number;
  readonly atMs: number;
  /** True when the stack itself cut this payload before reporting it. */
  readonly truncated: boolean;
  readonly payload?: Buffer | undefined;
  readonly textOmitted?: "truncated" | "invalid-utf8" | undefined;
}

/** One probe run, as this service needs it — whichever stack produced it. */
interface ProbeResult {
  readonly upgraded: boolean;
  /** Absent when the stack does not observe the response. */
  readonly handshake:
    | {
        readonly status: number;
        readonly headers: Readonly<Record<string, string>>;
        readonly negotiatedSubprotocol: string | undefined;
      }
    | undefined;
  readonly frames: readonly ProbeFrame[];
  readonly close:
    | { readonly code: number | undefined; readonly reason: string | undefined }
    | undefined;
  readonly closedCleanly: boolean;
  readonly elapsedMs: number;
  readonly transportError: string | undefined;
  /** Frames the stack received after its frame log was full. */
  readonly framesWithheld: number;
  readonly notObservable: readonly string[] | undefined;
  readonly abandoned: boolean | undefined;
  /**
   * True when the caller's signal ended the probe rather than the peer did.
   *
   * The two stacks record this differently — the node client sets a flag on its
   * result, the native probe reports an outcome kind — and this is the one place
   * both are read, so that "the caller stopped it" is one fact here rather than
   * two.
   */
  readonly cancelled: boolean;
}

const fromNodeFrame = (frame: WebSocketFrame): ProbeFrame => ({
  direction: frame.direction,
  opcode: frame.opcode,
  bytes: frame.bytes,
  atMs: frame.atMs,
  // Nothing was cut before this call saw the frame; the only cut is the one the
  // payload limit makes, which the mapping below applies and reports.
  truncated: false,
  payload: frame.payload,
});

const fromNativeFrame = (frame: NativeProbeFrame): ProbeFrame => ({
  direction: frame.direction,
  opcode: frame.opcode,
  bytes: frame.bytes,
  atMs: frame.atMs,
  truncated: frame.truncated,
  ...(frame.text === undefined ? {} : { payload: Buffer.from(frame.text, "utf8") }),
  ...(frame.base64 === undefined ? {} : { payload: Buffer.from(frame.base64, "base64") }),
  ...(frame.textOmitted === undefined ? {} : { textOmitted: frame.textOmitted }),
});

/** One frame of a probe result, as the tool's output carries it. */
interface ProbeOutputFrame {
  readonly direction: "sent" | "received";
  readonly opcode: "text" | "binary" | "ping" | "pong";
  readonly bytes: number;
  readonly text?: string;
  readonly base64?: string;
  readonly text_omitted?: "truncated" | "invalid-utf8";
  readonly at_ms: number;
  readonly truncated: boolean;
}

/**
 * One probe, as the tool's output carries it.
 *
 * Named rather than inline because the two stacks produce different facts and the
 * differences have to stay visible: `handshake` and `not_observable` are optional
 * because one stack does not produce them, and a required field would have to be
 * filled with a value that was never observed.
 */
interface WebSocketProbeOutput {
  exchange_id: string;
  stack: "node" | "libuvcpp";
  upgraded: boolean;
  handshake?: {
    status: number;
    headers: Record<string, string>;
    negotiated_subprotocol?: string;
  };
  frames: ProbeOutputFrame[];
  expectations: {
    text: string;
    matched: boolean;
    matched_frame_index?: number;
  }[];
  expectations_met: boolean;
  transport_error?: string;
  close?: { code?: number; reason?: string };
  closed_cleanly: boolean;
  not_observable?: string[];
  abandoned?: boolean;
}

/**
 * The frame log as the output carries it.
 *
 * The close handshake is reported through `close` rather than as traffic, so it
 * is filtered out here; a frame whose payload a stack would not hand over carries
 * neither text nor base64 and says why, because substituting a decode of a
 * partial payload would be inventing bytes.
 */
const probeOutputFrames = (frames: readonly ProbeFrame[]): ProbeOutputFrame[] =>
  frames
    .filter((frame) => frame.opcode !== "close")
    .map((frame): ProbeOutputFrame => {
      const opcode = frame.opcode as ProbeOutputFrame["opcode"];
      if (frame.payload === undefined) {
        return {
          direction: frame.direction,
          opcode,
          bytes: frame.bytes,
          ...(frame.textOmitted === undefined ? {} : { text_omitted: frame.textOmitted }),
          at_ms: frame.atMs,
          truncated: frame.truncated,
        };
      }
      const payload = framePayload(
        {
          direction: frame.direction,
          opcode: frame.opcode,
          bytes: frame.bytes,
          payload: frame.payload,
          atMs: frame.atMs,
          protocolError: false,
        },
        FRAME_PAYLOAD_BYTES,
      );
      return {
        direction: frame.direction,
        opcode,
        bytes: frame.bytes,
        ...(payload.text === undefined ? {} : { text: payload.text }),
        ...(payload.base64 === undefined ? {} : { base64: payload.base64 }),
        at_ms: frame.atMs,
        // Either the stack cut this payload before reporting it, or the limit cut
        // it here. Both mean the same thing to a caller reading the field.
        truncated: frame.truncated || payload.truncated,
      };
    });

/** The output of one probe, from the facts that probe produced. */
const probeOutput = (parts: {
  readonly exchangeId: string;
  readonly stack: "node" | "libuvcpp";
  readonly result: ProbeResult;
  readonly frames: readonly ProbeOutputFrame[];
  readonly expectations: WebSocketProbeOutput["expectations"];
}): WebSocketProbeOutput => {
  const { result } = parts;
  const handshake = result.handshake;
  const close = result.close;
  return {
    exchange_id: parts.exchangeId,
    stack: parts.stack,
    upgraded: result.upgraded,
    ...(handshake === undefined
      ? {}
      : {
          handshake: {
            status: handshake.status,
            headers: { ...handshake.headers },
            ...(handshake.negotiatedSubprotocol === undefined
              ? {}
              : { negotiated_subprotocol: handshake.negotiatedSubprotocol }),
          },
        }),
    frames: [...parts.frames],
    expectations: parts.expectations,
    expectations_met: parts.expectations.every((expectation) => expectation.matched),
    ...(result.transportError === undefined ? {} : { transport_error: result.transportError }),
    ...(close === undefined
      ? {}
      : {
          close: {
            ...(close.code === undefined ? {} : { code: close.code }),
            ...(close.reason === undefined ? {} : { reason: close.reason }),
          },
        }),
    closed_cleanly: result.closedCleanly,
    ...(result.notObservable === undefined ? {} : { not_observable: [...result.notObservable] }),
    ...(result.abandoned === true ? { abandoned: true } : {}),
  };
};

/** Anything the native stack could not do, as the failure a caller acts on. */
const nativeProbeFailure = (
  outcome: Exclude<NativeProbeOutcome, { kind: "report" }>,
  url: string,
): UvpFailure => {
  switch (outcome.kind) {
    case "stack-unavailable":
      return new UvpFailure({
        code: "toolchain_unavailable",
        message:
          outcome.state === "unavailable"
            ? `The native WebSocket probe is not available on this host: ${outcome.reason}.`
            : `Whether the native WebSocket probe works on this host could not be determined: ${outcome.reason}.`,
        remediation: {
          action:
            'Build it with `npm run build:native-probe`, point UVP_NATIVE_PROBE at a build you have, or probe with stack: "node".',
        },
        details: {
          state: outcome.state,
          reason: outcome.reason,
          ...(outcome.path === undefined ? {} : { path: outcome.path }),
          url,
        },
      });
    case "request-refused":
      // The probe's own words. It refuses only requests this stack cannot serve,
      // and it says which part, so the message is the reason and not a summary.
      return new UvpFailure({
        code: "invalid_request",
        message: `The native WebSocket probe refused this request: ${outcome.message}.`,
        remediation: {
          action:
            'Probe with stack: "node", which supports wss://, request headers, subprotocols, and a paced send.',
        },
        details: { url, stack: "libuvcpp" },
      });
    case "cancelled":
      return cancelledFailure(
        "The native WebSocket probe was cancelled; it was killed and observed nothing more.",
      );
    case "probe-failed":
      return new UvpFailure({
        code: "execution_failure",
        message: `The native WebSocket probe produced no report: ${outcome.message}.`,
        remediation: {
          action:
            "Check that the probe binary at that path runs (`uvcpp-probe --version`), then re-run the probe.",
        },
        details: { url, ...(outcome.detail === "" ? {} : { probe_said: outcome.detail }) },
      });
  }
};

/**
 * Refuse a request this stack cannot serve, as the failure a caller acts on.
 *
 * Every one of these is knowable without asking the far end anything, and said
 * before a process is spawned. The alternative is a probe that ignores part of
 * the request and returns a result that reads like an answer about it: the
 * caller's headers dropped, a paced send flattened into an unpaced one, and a
 * frame log that looks like evidence for a question nobody asked.
 *
 * It throws rather than returning a failure, and the return type says so. A
 * refusal that is *built* and not thrown is exactly that probe of a different
 * request — the mistake is one forgotten keyword away and invisible in the
 * output — so here there is no keyword to forget.
 *
 * Pacing is the one limit the probe refuses as well. That is deliberate, and not
 * a second opinion: the probe is the only place that can promise it will not
 * silently drop a caller's pacing. Doing it here too is what makes the answer
 * independent of whether a probe binary happens to be on this host — otherwise a
 * paced send is `invalid_request` on one machine and `toolchain_unavailable` on
 * the next.
 */
const refuseNativeLimits = (input: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly subprotocols: readonly string[];
  readonly send: readonly { readonly wait_ms: number }[];
}): void => {
  const refuse = (limit: string): never => {
    throw new UvpFailure({
      code: "invalid_request",
      message: `stack: "libuvcpp" cannot probe this request: ${limit}.`,
      remediation: { action: `Probe with stack: "node", which supports ${limit}.` },
      details: { url: input.url, stack: "libuvcpp" },
    });
  };

  if (!input.url.startsWith("ws://")) {
    // The C ABI's client speaks `ws://` only: there is no TLS in it. Refused
    // rather than attempted, because a probe that tried anyway would report a
    // handshake failure that says nothing about the server.
    refuse("wss:// URLs, since the C ABI's client has no TLS");
  }
  if (Object.keys(input.headers).length > 0) refuse("request headers");
  if (input.subprotocols.length > 0) refuse("subprotocols");
  if (input.send.some((message) => message.wait_ms !== 0)) refuse("a paced send (wait_ms)");
};

export class WebService {
  constructor(private readonly options: WebServiceOptions) {}

  private get now(): () => Date {
    return this.options.now ?? ((): Date => new Date());
  }

  /**
   * One HTTP request, reported in full.
   *
   * `http_version: "3"` goes to `Http3Client` rather than to Node, and goes there
   * only after the URL has been parsed here. Both halves of that matter: Node's
   * standard library has no HTTP/3 client at all, so answering an HTTP/1.1 request
   * while the caller asked for HTTP/3 would be a green result for a transport that
   * was never exercised; and a URL this tool would not accept over HTTP/1.1 is not
   * one it should accept over HTTP/3 either, so the validation is shared rather
   * than duplicated on the far side of a process boundary.
   */
  async httpRequest(
    input: HttpRequestInput,
    recorder: EvidenceRecorder,
    signal: AbortSignal,
  ): Promise<HttpRequestOutput> {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new UvpFailure({
        code: "invalid_request",
        message: `"${input.url}" is not an absolute URL.`,
        remediation: {
          action: "Pass a URL including the scheme, such as http://127.0.0.1:8080/hello.",
        },
      });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new UvpFailure({
        code: "invalid_request",
        message: `Unsupported scheme "${url.protocol}".`,
        remediation: {
          action: "Use http:// or https://. For WebSocket endpoints use uvp_websocket_probe.",
        },
      });
    }

    if (input.http_version === "3") {
      const http3 = this.options.nativeHttp3Probe;
      if (http3 === undefined) {
        throw new UvpFailure({
          code: "toolchain_unavailable",
          message:
            "This uvp was built without the native HTTP/3 probe, so http_version=3 cannot run.",
          remediation: {
            action:
              "Ask over http_version=auto, 2, or 1.1, or use a uvp build that includes the native probe.",
          },
          details: { url: input.url, http_version: "3" },
        });
      }
      return await new Http3Client(http3, this.options.store, this.now, recorder).request(
        input,
        signal,
      );
    }

    const requestBody =
      input.body === undefined
        ? undefined
        : Buffer.from(input.body, input.body_encoding === "base64" ? "base64" : "utf8");

    const started = Date.now();
    const exchange = await performRequest({
      url: input.url,
      method: input.method,
      headers: input.headers,
      body: requestBody,
      httpVersion: input.http_version,
      followRedirects: input.follow_redirects,
      maxRedirects: input.max_redirects,
      verifyTls: input.verify_tls,
      timeoutMs: input.timeout_ms,
    }).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      // The transport classified the failure where it saw it; matching the
      // message here instead made the two disagree the moment either changed.
      const kind = transportFailureKind(cause);
      const timedOut = kind === "timeout";
      // A certificate this client would not accept is the third thing that is
      // not an unreachable endpoint, and the one whose message matters most.
      // The service is listening, it completed a handshake, and it presented a
      // certificate — telling the caller to check the host and port sends them
      // to inspect the one part that worked, and `retryable: true` sends them
      // back to do it again. Every one of these is already the reason string
      // OpenSSL gave, so the answer to "why" is in hand and only has to be
      // reported as itself.
      const certificateRejected = kind === "tls";
      // The stable name of what was wrong, which Node's message does not carry.
      // `CERT_HAS_EXPIRED` and `ERR_TLS_CERT_ALTNAME_INVALID` want opposite
      // actions and both arrive as prose.
      const reasonCode = cause instanceof TransportFailure ? cause.code : undefined;
      // A version the caller *pinned* that the peer did not answer in is not an
      // unreachable endpoint. The service is listening — it replied something
      // this client could not parse as HTTP/2 — and telling the caller to check
      // the host and port sends them to look at the one thing that is working.
      // `auto` never lands here: it falls back rather than failing.
      const wrongProtocol = kind === "protocol" && input.http_version !== "auto";
      throw new UvpFailure({
        code: timedOut
          ? "timeout"
          : certificateRejected
            ? "target_unavailable"
            : wrongProtocol
              ? "unsupported_target"
              : "endpoint_unreachable",
        message: certificateRejected
          ? `${input.method} ${input.url} presented a certificate this client would not accept` +
            `${reasonCode === undefined ? "" : ` (${reasonCode})`}: ${message}`
          : wrongProtocol
            ? `${input.method} ${input.url} reached a service that did not answer in HTTP/${input.http_version}: ${message}`
            : `${input.method} ${input.url} did not complete: ${message}`,
        remediation: {
          action: timedOut
            ? "Raise timeout_ms, or check whether the service is still starting up."
            : certificateRejected
              ? `Decide which of the two this is, because the remedies are opposite: if the service ` +
                `is meant to be trusted, give this client its CA (NODE_EXTRA_CA_CERTS); if it is a ` +
                `service generated for local use, its self-signed certificate is expected and ` +
                `--no-tls (verify_tls: false) is the honest way to say you are not checking it.`
              : wrongProtocol
                ? `Ask over a version the service speaks, or make it speak this one. For a ` +
                  `generated service that means the http2 feature at creation time ` +
                  `(uvp init --features http2), which turns on cleartext h2 alongside HTTP/1.1.`
                : "Check that the service is listening on that host and port, then retry.",
        },
        details: {
          url: input.url,
          method: input.method,
          requested_http_version: input.http_version,
          elapsed_ms: Date.now() - started,
          ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
          ...(certificateRejected ? { verify_tls: input.verify_tls } : {}),
        },
      });
    });

    if (signal.aborted) {
      throw cancelledFailure("The request was cancelled after it completed.");
    }

    const stored = remember(this.options.store, this.now, {
      method: input.method,
      url: exchange.url,
      requestHeaders: input.headers,
      requestBody,
      response: exchange,
      durationMs: exchange.timing.totalMs,
      error: undefined,
      captureId: undefined,
    });

    const contentType = exchange.headers["content-type"];
    const maxBytes = Math.min(
      input.max_body_bytes,
      this.options.maxBodyBytes ?? input.max_body_bytes,
    );
    const truncated = exchange.body.byteLength > maxBytes;
    const bodyBytes = truncated ? exchange.body.subarray(0, maxBytes) : exchange.body;
    const decoded = decodeBody(bodyBytes, contentType);
    const tls = toTls(exchange);

    // One exchange, one evidence record. The negotiated version and the TLS
    // outcome are `observed`; nothing here is inferred from the request.
    record(recorder, {
      kind: "exchange",
      subject: { method: input.method, url: exchange.url, exchange_id: stored.exchangeId },
      observed: {
        status: exchange.status,
        http_version: exchange.httpVersion,
        response_bytes: exchange.body.byteLength,
        redirects: exchange.redirects.length,
      },
      derived: {
        // Absent for a cleartext exchange rather than `false`. There is no TLS
        // to have verified and no certificate to have rejected, and a `false`
        // here is read by every consumer as a verification that failed — the
        // record claimed, about a plaintext request, the one thing that could
        // not be true of it.
        ...(tls === undefined ? {} : { tls_verification: tls.verification }),
        truncated: truncated || exchange.bodyTruncated,
      },
      coverage: coverageComplete("HTTP exchange"),
      sources: [endpointSource(exchange.url)],
      limitations:
        truncated || exchange.bodyTruncated
          ? [
              `The response body was capped at ${String(maxBytes)} bytes; the digest is over the full body.`,
            ]
          : [],
    });

    return {
      exchange_id: stored.exchangeId,
      request: { method: input.method, url: input.url },
      status: exchange.status,
      status_text: exchange.statusText,
      http_version: exchange.httpVersion,
      request_http_version: exchange.requestHttpVersion,
      headers: { ...exchange.headers },
      timing: toTiming(exchange.timing),
      body: {
        bytes: exchange.body.byteLength,
        ...(contentType === undefined ? {} : { content_type: contentType }),
        ...(decoded.text === undefined ? {} : { text: decoded.text }),
        ...(decoded.base64 === undefined ? {} : { base64: decoded.base64 }),
        truncated: truncated || exchange.bodyTruncated,
        decoded_as_text: decoded.decodedAsText,
        digest: sha256(exchange.body),
      },
      redirects: [...exchange.redirects],
      ...(tls === undefined ? {} : { tls }),
    };
  }

  /**
   * A WebSocket probe.
   *
   * The handshake and the frames are reported separately because they answer
   * different questions. A 403 on the upgrade says the route exists and refused
   * this client; a 101 followed by no frames says the opposite, and a caller who
   * saw only "no frames" would draw the wrong conclusion from either.
   *
   * Two stacks can run it. The Node client does it in-process and sees the whole
   * response; the libuvcpp C ABI is driven as a separate process and sees less.
   * The differences are not smoothed over — they are refused where the request
   * cannot be served at all (`wss://`, headers, subprotocols, a paced send), and
   * reported as `not_observable` where the stack simply cannot see something. The
   * alternative — quietly dropping the caller's headers and returning a probe of
   * a request that was never made — is the failure this branch exists to avoid.
   */
  async websocketProbe(
    input: {
      readonly url: string;
      readonly stack: "node" | "libuvcpp";
      readonly headers: Readonly<Record<string, string>>;
      readonly subprotocols: readonly string[];
      readonly send: readonly {
        readonly payload: string;
        readonly encoding: "utf8" | "base64";
        readonly wait_ms: number;
      }[];
      readonly expect: readonly string[];
      readonly max_frames: number;
      readonly idle_timeout_ms: number;
      readonly verify_tls: boolean;
    },
    recorder: EvidenceRecorder,
    signal: AbortSignal,
  ): Promise<WebSocketProbeOutput> {
    const probe =
      input.stack === "libuvcpp"
        ? await this.nativeProbe(input, signal)
        : await this.nodeProbe(input, signal);

    const result = probe.result;

    // Before the unreachable branch, because that branch was where a stopped call
    // used to come out: the node client ends an aborted probe with
    // `transportError: "cancelled"` and no handshake, which is exactly the shape of
    // an endpoint that refused a connection — so `uvp websocket-probe`, interrupted,
    // reported that the address could not be reached and told the caller to check
    // that the service was listening. A status of 0 is the part that makes this a
    // claim about nothing: a peer that answered, even to reject the upgrade,
    // answered.
    if (result.cancelled && result.handshake?.status === 0) {
      throw cancelledFailure(
        "The WebSocket probe was cancelled before the endpoint answered, so nothing was observed " +
          "about the endpoint.",
      );
    }

    if (!result.upgraded && result.handshake?.status === 0) {
      throw new UvpFailure({
        code: "endpoint_unreachable",
        message: `${input.url} could not be reached: ${result.transportError ?? "no response"}.`,
        remediation: {
          action: "Check that the service is listening, and that the URL uses ws:// or wss://.",
        },
        details: { url: input.url },
      });
    }

    const stored = remember(this.options.store, this.now, {
      method: "GET",
      url: input.url,
      requestHeaders: input.headers,
      requestBody: undefined,
      response: undefined,
      durationMs: result.elapsedMs,
      error: result.upgraded
        ? undefined
        : (result.transportError ??
          `upgrade rejected with status ${String(result.handshake?.status)}`),
      captureId: undefined,
    });

    if (result.cancelled) {
      // The probe got far enough to observe something and was stopped before the
      // peer was done. That is a gap in the log, not a finding about the peer, and
      // `cancelled` is the reason the vocabulary has for it — `resource_limit`,
      // which this used to say through the transport error, describes a bound the
      // probe imposed on itself.
      recordUnknown(
        recorder,
        "Did the WebSocket connection stay healthy for the whole probe?",
        "cancelled",
        { blockedBy: "the call was cancelled, so the probe stopped before the peer did" },
      );
    } else if (result.transportError !== undefined && result.upgraded) {
      recordUnknown(
        recorder,
        "Did the WebSocket connection stay healthy for the whole probe?",
        "resource_limit",
        { blockedBy: result.transportError },
      );
    }
    if (result.abandoned === true) {
      // The report was written out from under a client loop that never returned.
      // Anything the far end sent after the last recorded frame was never read,
      // which is a gap in the evidence rather than an absence of traffic.
      recordUnknown(
        recorder,
        "What did the far end send after the probe's last recorded frame?",
        "resource_limit",
        {
          blockedBy:
            "the probe's client loop never returned, so the run ended without reading further",
        },
      );
    }

    const frames = probeOutputFrames(result.frames);

    // The expectation is answered here rather than left to each caller, because
    // "did the far end say what I expected" is the question a probe is asked and
    // a caller comparing strings against the frame log is a second implementation
    // of it. Only received frames count: a frame uvp sent is not evidence that
    // the peer spoke, and matching against it would make an expectation pass on a
    // server that never answered.
    const expectations = input.expect.map((text) => {
      const index = frames.findIndex(
        (frame) => frame.direction === "received" && (frame.text?.includes(text) ?? false),
      );
      return index < 0
        ? { text, matched: false }
        : { text, matched: true, matched_frame_index: index };
    });

    // The probe's own record. Without it a successful probe carries no evidence
    // at all — only the exchange in the store — and an expectation that did not
    // hold would be a field in the output rather than a claim in the record.
    record(recorder, {
      kind: "exchange",
      subject: {
        method: "GET",
        url: input.url,
        exchange_id: stored.exchangeId,
        upgrade: result.upgraded ? "accepted" : "rejected",
        stack: input.stack,
      },
      observed: {
        handshake_status: result.handshake?.status,
        handshake_observed: result.handshake !== undefined,
        frames_received: frames.filter((frame) => frame.direction === "received").length,
        frames_sent: frames.filter((frame) => frame.direction === "sent").length,
        frames_withheld: result.framesWithheld,
        expectations_checked: expectations.length,
        expectations_met: expectations.filter((expectation) => expectation.matched).length,
        closed_cleanly: result.closedCleanly,
      },
      coverage: result.upgraded
        ? coverageComplete("WebSocket probe")
        : coveragePartial(
            "WebSocket probe",
            "the upgrade was not accepted, so no frames were exchanged",
            0,
            1,
          ),
      sources: [endpointSource(input.url)],
      limitations: [
        "The frame log is bounded by max_frames and idle_timeout_ms, so it is the traffic observed and not a full transcript.",
        ...probe.limitations,
      ],
    });

    return probeOutput({
      exchangeId: stored.exchangeId,
      stack: input.stack,
      result,
      frames,
      expectations,
    });
  }

  /**
   * One probe, as the rest of this method needs it.
   *
   * `handshake` is optional here rather than on the way out only: the native stack
   * does not produce one, and a shape that forced a value would be filled in with
   * a status that was never observed.
   */
  private async nodeProbe(
    input: {
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly subprotocols: readonly string[];
      readonly send: readonly {
        readonly payload: string;
        readonly encoding: "utf8" | "base64";
        readonly wait_ms: number;
      }[];
      readonly max_frames: number;
      readonly idle_timeout_ms: number;
      readonly verify_tls: boolean;
    },
    signal: AbortSignal,
  ): Promise<{
    result: ProbeResult;
    limitations: readonly string[];
  }> {
    const result = await probeWebSocket({
      url: input.url,
      headers: input.headers,
      subprotocols: input.subprotocols,
      verifyTls: input.verify_tls,
      maxFrames: input.max_frames,
      idleTimeoutMs: input.idle_timeout_ms,
      send: input.send.map((message) => ({
        payload: message.payload,
        encoding: message.encoding,
        waitMs: message.wait_ms,
      })),
      signal,
    });

    return {
      result: {
        upgraded: result.upgraded,
        handshake: result.handshake,
        frames: result.frames.map(fromNodeFrame),
        close: result.close,
        closedCleanly: result.closedCleanly,
        elapsedMs: result.elapsedMs,
        transportError: result.transportError,
        framesWithheld: 0,
        notObservable: undefined,
        abandoned: undefined,
        cancelled: result.cancelled,
      },
      limitations: [],
    };
  }

  /**
   * The same probe, on libuvcpp's own client.
   *
   * Every refusal here is a request this stack cannot serve, said before anything
   * is spawned, because the alternative is a probe that ignores part of the
   * request and returns a result that looks like an answer about it.
   */
  private async nativeProbe(
    input: {
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly subprotocols: readonly string[];
      readonly send: readonly {
        readonly payload: string;
        readonly encoding: "utf8" | "base64";
        readonly wait_ms: number;
      }[];
      readonly max_frames: number;
      readonly idle_timeout_ms: number;
    },
    signal: AbortSignal,
  ): Promise<{ result: ProbeResult; limitations: readonly string[] }> {
    const native = this.options.nativeProbe;
    if (native === undefined) {
      throw new UvpFailure({
        code: "toolchain_unavailable",
        message: 'This uvp was built without the native probe, so stack: "libuvcpp" cannot run.',
        remediation: {
          action: 'Probe with stack: "node", or use a uvp build that includes the native probe.',
        },
      });
    }

    refuseNativeLimits(input);

    const idleTimeoutMs = input.idle_timeout_ms;
    const outcome = await native.probe(
      {
        url: input.url,
        send: input.send.map((message) => ({
          payload: message.payload,
          encoding: message.encoding,
          waitMs: message.wait_ms,
        })),
        maxFrames: input.max_frames,
        maxFrameBytes: FRAME_PAYLOAD_BYTES,
        idleTimeoutMs,
        // The probe's own ceiling, which is a backstop: a busy connection ends the
        // run at the frame cap or the idle timeout first. Deriving it here rather
        // than asking the caller keeps one timeout in the contract.
        totalTimeoutMs: idleTimeoutMs + NATIVE_TOTAL_TIMEOUT_SLACK_MS,
      },
      signal,
    );

    if (outcome.kind !== "report") {
      throw nativeProbeFailure(outcome, input.url);
    }

    const report = outcome.report;
    const limitations = [
      "The libuvcpp C ABI reports a completed upgrade without the response that carried it, so this probe has no handshake status or headers.",
      "A failed handshake arrives as a transport status with no HTTP response, so a rejected upgrade and an endpoint that could not be reached are not distinguishable on this stack.",
      "The probe runs as a separate process: it reads no ping or pong frames, and it ends without a closing handshake unless the frame cap was reached.",
      ...(report.framesWithheld === 0
        ? []
        : [
            `${String(report.framesWithheld)} further frames were received after the frame log was full; they are counted in the record and not listed.`,
          ]),
      ...(report.abandoned
        ? [
            "The probe's client loop never returned, so its report was written out from under a run that was still parked; the frame log ends where its evidence ends.",
          ]
        : []),
    ];

    return {
      result: {
        upgraded: report.upgraded,
        handshake: undefined,
        frames: report.frames.map(fromNativeFrame),
        close:
          report.close === undefined
            ? undefined
            : { code: report.close.code, reason: report.close.reason },
        // Inferred from the close code rather than seen, and the inference is
        // sound in one direction only: RFC 6455 §7.1.5 defines 1006 as a close
        // that had no Close frame, so a code that is not 1006 means one arrived.
        closedCleanly: report.close?.closeFrameReceived ?? false,
        elapsedMs: report.totalMs,
        transportError:
          report.error === undefined
            ? undefined
            : `${report.error.what} (status ${String(report.error.code)})`,
        framesWithheld: report.framesWithheld,
        notObservable: report.notObservable,
        abandoned: report.abandoned,
        // The native stack never reaches here cancelled: its runner reports a
        // cancelled run as an outcome kind, and the branch above turns that into
        // a `cancelled` failure rather than a result. Saying so here is what keeps
        // the two stacks comparable at the place they are compared.
        cancelled: false,
      },
      limitations,
    };
  }

  /**
   * A SOAP invocation.
   *
   * A SOAP fault arrives as HTTP 500 with a fault document in the body. Treating
   * that as a transport error would throw away the fault code and reason — which
   * are the only things the caller can act on — so the fault is parsed out and
   * reported as the protocol outcome it is.
   */
  async soapCall(
    input: {
      readonly endpoint: string;
      readonly soap_version: "1.1" | "1.2";
      readonly operation: string | undefined;
      readonly namespace: string | undefined;
      readonly parameters: Readonly<Record<string, unknown>>;
      readonly raw_envelope: string | undefined;
      readonly soap_action: string | undefined;
      readonly headers: Readonly<Record<string, string>>;
      readonly timeout_ms: number;
    },
    recorder: EvidenceRecorder,
    signal: AbortSignal,
  ): Promise<{
    exchange_id: string;
    status: number;
    outcome: "success" | "fault" | "transport_error";
    fault?: { code?: string; subcode?: string; reason?: string; detail?: string };
    body: { bytes: number; text?: string; truncated: boolean; digest: string };
    timing: ReturnType<typeof toTiming>;
  }> {
    const envelope =
      input.raw_envelope ??
      buildSoapEnvelope(input.soap_version, input.operation, input.namespace, input.parameters);
    const contentType =
      input.soap_version === "1.2"
        ? "application/soap+xml; charset=utf-8"
        : "text/xml; charset=utf-8";
    const headers: Record<string, string> = {
      "content-type": contentType,
      ...(input.soap_version === "1.1"
        ? { soapaction: `"${input.soap_action ?? input.operation ?? ""}"` }
        : {}),
      ...input.headers,
    };

    const started = Date.now();
    const exchange = await performRequest({
      url: input.endpoint,
      method: "POST",
      headers,
      body: Buffer.from(envelope, "utf8"),
      httpVersion: "auto",
      followRedirects: false,
      maxRedirects: 0,
      verifyTls: true,
      timeoutMs: input.timeout_ms,
    }).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      const record = remember(this.options.store, this.now, {
        method: "POST",
        url: input.endpoint,
        requestHeaders: headers,
        requestBody: Buffer.from(envelope, "utf8"),
        response: undefined,
        durationMs: Date.now() - started,
        error: message,
        captureId: undefined,
      });
      // A transport failure is one of this tool's outcomes, so it is returned
      // rather than thrown — but the unknown is recorded either way, because a
      // `transport_error` result is not evidence about the operation.
      recordUnknown(
        recorder,
        `Did the ${input.operation ?? "SOAP"} operation succeed?`,
        "not_attempted",
        {
          blockedBy: message,
          partialEvidence: [record.exchangeId],
        },
      );
      return undefined;
    });

    if (signal.aborted) {
      // Before the transport outcome is interpreted, not after. A call the
      // caller withdrew did not fail to reach the service, and reporting it as
      // `transport_error` would assert that the far end stayed silent — a claim
      // about the far end that a run this one abandoned cannot support.
      throw cancelledFailure("The SOAP call was cancelled before its result was read.");
    }

    if (exchange === undefined) {
      return {
        exchange_id: newId("exchange"),
        status: 0,
        outcome: "transport_error",
        body: { bytes: 0, truncated: false, digest: sha256("") },
        timing: { total_ms: Date.now() - started },
      };
    }

    const stored = remember(this.options.store, this.now, {
      method: "POST",
      url: input.endpoint,
      requestHeaders: headers,
      requestBody: Buffer.from(envelope, "utf8"),
      response: exchange,
      durationMs: exchange.timing.totalMs,
      error: undefined,
      captureId: undefined,
    });

    const text = exchange.body.toString("utf8");
    const fault = parseSoapFault(text);
    if (fault !== undefined) {
      recordUnknown(
        recorder,
        `Did the ${input.operation ?? "SOAP"} operation return a successful result?`,
        "not_attempted",
        {
          blockedBy: fault.reason ?? fault.code ?? "the service returned a SOAP fault",
          partialEvidence: [stored.exchangeId],
        },
      );
    }

    return {
      exchange_id: stored.exchangeId,
      status: exchange.status,
      outcome: fault === undefined ? "success" : "fault",
      ...(fault === undefined ? {} : { fault }),
      body: {
        bytes: exchange.body.byteLength,
        text: text.slice(0, 64 * 1024),
        truncated: exchange.body.byteLength > 64 * 1024 || exchange.bodyTruncated,
        digest: sha256(exchange.body),
      },
      timing: toTiming(exchange.timing),
    };
  }

  /**
   * A bounded load test.
   *
   * Reports a distribution and a status histogram rather than a mean, because a
   * mean latency of 12 ms is consistent with both "uniformly fast" and "half the
   * requests timed out". The error breakdown names the causes, and the status
   * histogram shows a partial outage as a shape.
   *
   * The individual timings are kept, not only the summary. A p99 that cannot be
   * traced back to a measurement is a number, and a caller who wants to know
   * whether the tail was one outlier or a plateau has to be able to look. Keeping
   * every sample would make a million-request run a memory leak, so the samples
   * are retained on a uniform stride and the count not retained is reported:
   * every number returned is computed from exactly the samples returned.
   */
  async loadTest(
    input: {
      readonly url: string;
      readonly method: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string | undefined;
      readonly concurrency: number;
      readonly requests: number;
      readonly duration_ms: number;
      readonly timeout_ms: number;
      readonly warmup_requests: number;
      readonly verify_tls: boolean;
      readonly max_samples: number;
    },
    signal: AbortSignal,
  ): Promise<{
    requests_sent: number;
    requests_completed: number;
    requests_failed: number;
    duration_ms: number;
    throughput_rps: number;
    latency_ms: {
      min: number;
      p50: number;
      p90: number;
      p95: number;
      p99: number;
      max: number;
      mean: number;
      stddev: number;
    };
    status_histogram: Record<string, number>;
    errors: { kind: string; count: number; sample: string }[];
    completed_by_count: boolean;
    samples: number[];
    samples_retained: number;
    samples_dropped: number;
  }> {
    const samples: number[] = [];
    const histogram = new Map<string, number>();
    const errorCounts = new Map<string, { count: number; sample: string }>();
    let sent = 0;
    let completed = 0;
    let failed = 0;
    let stop = false;

    // Derived from the requested count rather than from the run, so the same
    // inputs retain the same samples however long the endpoint takes to answer.
    const stride = Math.max(1, Math.ceil(input.requests / input.max_samples));

    const deadline = Date.now() + input.duration_ms;
    let completedByCount = false;

    const one = async (): Promise<void> => {
      while (!stop && sent < input.requests && Date.now() < deadline && !signal.aborted) {
        sent += 1;
        const started = Date.now();
        try {
          const exchange = await performRequest({
            url: input.url,
            method: input.method,
            headers: input.headers,
            body: input.body === undefined ? undefined : Buffer.from(input.body, "utf8"),
            httpVersion: "auto",
            followRedirects: false,
            maxRedirects: 0,
            verifyTls: input.verify_tls,
            timeoutMs: input.timeout_ms,
          });
          const elapsed = Date.now() - started;
          if (completed % stride === 0) samples.push(Math.min(elapsed, MS_CAP));
          completed += 1;
          const key = String(exchange.status);
          histogram.set(key, (histogram.get(key) ?? 0) + 1);
        } catch (cause) {
          failed += 1;
          const message = cause instanceof Error ? cause.message : String(cause);
          const kind = transportFailureKind(cause) === "timeout" ? "timeout" : "transport";
          const entry = errorCounts.get(kind);
          if (entry === undefined) errorCounts.set(kind, { count: 1, sample: message });
          else entry.count += 1;
        }
      }
    };

    const startedAt = Date.now();
    for (let index = 0; index < input.warmup_requests && !signal.aborted; index += 1) {
      try {
        await performRequest({
          url: input.url,
          method: input.method,
          headers: input.headers,
          body: input.body === undefined ? undefined : Buffer.from(input.body, "utf8"),
          httpVersion: "auto",
          followRedirects: false,
          maxRedirects: 0,
          verifyTls: input.verify_tls,
          timeoutMs: input.timeout_ms,
        });
      } catch {
        // Warm-up failures are reported by the measured run, not by themselves:
        // counting them would double-count the same broken endpoint.
      }
    }

    await Promise.all(
      Array.from({ length: Math.max(1, input.concurrency) }, async () => {
        await one();
      }),
    );
    stop = true;
    completedByCount = sent >= input.requests && Date.now() < deadline;

    // Sorted for the quantiles, copied so the returned samples stay in the order
    // they were taken: the tail is easier to read as a sequence than as a list.
    const ordered = [...samples].sort((left, right) => left - right);
    const total = ordered.reduce((sum, value) => sum + value, 0);
    const mean = ordered.length === 0 ? 0 : total / ordered.length;
    const variance =
      ordered.length === 0
        ? 0
        : ordered.reduce((sum, value) => sum + (value - mean) ** 2, 0) / ordered.length;
    const elapsedMs = Date.now() - startedAt;

    return {
      requests_sent: sent,
      requests_completed: completed,
      requests_failed: failed,
      duration_ms: elapsedMs,
      throughput_rps: elapsedMs === 0 ? 0 : (completed * 1000) / elapsedMs,
      latency_ms: {
        min: ordered[0] ?? 0,
        p50: percentile(ordered, 0.5),
        p90: percentile(ordered, 0.9),
        p95: percentile(ordered, 0.95),
        p99: percentile(ordered, 0.99),
        max: ordered.at(-1) ?? 0,
        mean,
        stddev: Math.sqrt(variance),
      },
      status_histogram: Object.fromEntries([...histogram.entries()].sort()),
      errors: [...errorCounts.entries()]
        .map(([kind, entry]) => ({ kind, count: entry.count, sample: entry.sample }))
        .sort((left, right) => right.count - left.count),
      completed_by_count: completedByCount,
      samples,
      samples_retained: samples.length,
      // Failed requests contribute no timing, so this counts completed requests
      // the stride skipped and not requests that never answered.
      samples_dropped: Math.max(0, completed - samples.length),
    };
  }

  /**
   * Assertions over an exchange recorded earlier in this session.
   *
   * No traffic is sent. That is the point: a check can be re-evaluated against
   * a stored exchange, which is what makes a verification pass reproducible and
   * what lets a caller ask a second question about a response it already has.
   */
  assertExchange(input: {
    readonly exchange_id: string;
    readonly assertions: readonly {
      readonly kind: AssertionSpec["kind"];
      readonly target?: string | undefined;
      readonly expected?: unknown;
      readonly negate: boolean;
    }[];
  }): {
    exchange_id: string;
    passed: number;
    failed: number;
    results: {
      kind: string;
      target?: string;
      passed: boolean;
      observed: unknown;
      expected?: unknown;
      message: string;
    }[];
  } {
    const record = this.options.store.exchange(input.exchange_id);
    if (record === undefined) {
      throw new UvpFailure({
        code: "invalid_request",
        message: `No exchange ${input.exchange_id} was recorded in this session.`,
        remediation: {
          action:
            "Send the request first with uvp_http_request, or read a capture with uvp_capture_read. " +
            "Exchanges do not survive the end of a session.",
        },
      });
    }

    const outcomes = evaluateAssertions(
      record,
      input.assertions.map((spec) => ({
        kind: spec.kind,
        ...(spec.target === undefined ? {} : { target: spec.target }),
        ...(spec.expected === undefined ? {} : { expected: spec.expected }),
        negate: spec.negate,
      })),
    );

    return {
      exchange_id: input.exchange_id,
      passed: outcomes.filter((outcome) => outcome.passed).length,
      failed: outcomes.filter((outcome) => !outcome.passed).length,
      results: outcomes.map((outcome) => ({
        kind: outcome.kind,
        ...(outcome.target === undefined ? {} : { target: outcome.target }),
        passed: outcome.passed,
        observed: outcome.observed,
        ...(outcome.expected === undefined ? {} : { expected: outcome.expected }),
        message: outcome.message,
      })),
    };
  }
}

/** Build a SOAP envelope from an operation and its parameters. */
export const buildSoapEnvelope = (
  version: "1.1" | "1.2",
  operation: string | undefined,
  namespace: string | undefined,
  parameters: Readonly<Record<string, unknown>>,
): string => {
  if (operation === undefined) {
    throw new UvpFailure({
      code: "invalid_request",
      message: "A SOAP call needs either an operation or a raw envelope.",
      remediation: {
        action: "Pass operation (and namespace), or pass raw_envelope to send verbatim.",
      },
    });
  }
  const envelopeNs =
    version === "1.2"
      ? "http://www.w3.org/2003/05/soap-envelope"
      : "http://schemas.xmlsoap.org/soap/envelope/";
  const target = namespace === undefined ? "" : ` xmlns="${escapeXml(namespace)}"`;
  const body = Object.entries(parameters)
    .map(([name, value]) => `<${name}>${escapeXml(renderValue(value))}</${name}>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="${envelopeNs}">` +
    `<soap:Body><${operation}${target}>${body}</${operation}></soap:Body>` +
    `</soap:Envelope>`
  );
};

const renderValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  return JSON.stringify(value);
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** Text content of the first element with this local name, ignoring its prefix. */
const firstElementText = (xml: string, localName: string): string | undefined => {
  const match = new RegExp(
    `<(?:[A-Za-z0-9_.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${localName}>`,
    "iu",
  ).exec(xml);
  if (match?.[1] === undefined) return undefined;
  const text = match[1].replaceAll(/<[^>]*>/gu, "").trim();
  return text.length === 0 ? undefined : text;
};

/**
 * A SOAP fault, if the body is one.
 *
 * The presence of a `Fault` element is what decides `outcome: "fault"`, and it is
 * decided before any field is read: a fault whose `faultstring` this parser
 * cannot find is still a fault, and reporting it as a success because the parser
 * came up empty would be the single worst thing this function could do.
 */
export const parseSoapFault = (
  xml: string,
): { code?: string; subcode?: string; reason?: string; detail?: string } | undefined => {
  if (!/<(?:[A-Za-z0-9_.-]+:)?Fault\b/iu.test(xml)) return undefined;
  const code = firstElementText(xml, "faultcode") ?? firstElementText(xml, "Value");
  const subcode = firstElementText(xml, "Subcode");
  const reason =
    firstElementText(xml, "faultstring") ??
    firstElementText(xml, "Text") ??
    firstElementText(xml, "Reason");
  const detail = firstElementText(xml, "detail") ?? firstElementText(xml, "Detail");
  return {
    ...(code === undefined ? {} : { code }),
    ...(subcode === undefined ? {} : { subcode }),
    ...(reason === undefined ? {} : { reason }),
    ...(detail === undefined ? {} : { detail }),
  };
};
