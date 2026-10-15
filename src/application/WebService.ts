import { Buffer } from "node:buffer";

import { UvpFailure } from "../domain/errors.js";
import { newId, sha256 } from "../domain/identity.js";
import { decodeBody, performRequest, transportFailureKind } from "./httpClient.js";
import type { HttpExchange, HttpTiming } from "./httpClient.js";
import { evaluateAssertions, percentile } from "./assertions.js";
import type { AssertionSpec } from "./assertions.js";
import type { EvidenceRecorder } from "./evidenceHelpers.js";
import { coverageComplete, endpointSource, record, recordUnknown } from "./evidenceHelpers.js";
import { framePayload, probeWebSocket } from "./websocketClient.js";
import type { SessionStore, ExchangeRecord } from "./sessionStore.js";

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
}

const MS_CAP = 60 * 60 * 1000;

const toTiming = (
  timing: HttpTiming,
): {
  dns_ms?: number;
  connect_ms?: number;
  tls_ms?: number;
  ttfb_ms?: number;
  total_ms: number;
} => ({
  ...(timing.dnsMs === undefined ? {} : { dns_ms: timing.dnsMs }),
  ...(timing.connectMs === undefined ? {} : { connect_ms: timing.connectMs }),
  ...(timing.tlsMs === undefined ? {} : { tls_ms: timing.tlsMs }),
  ...(timing.ttfbMs === undefined ? {} : { ttfb_ms: timing.ttfbMs }),
  total_ms: timing.totalMs,
});

export interface ToolTlsReport {
  protocol?: string;
  cipher?: string;
  subject?: string;
  issuer?: string;
  valid_from?: string;
  valid_to?: string;
  verified: boolean;
  errors: string[];
}

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
    verified: tls.verified,
    errors: [...tls.errors],
  };
};

/**
 * Record an exchange in the session, so `uvp_assert_exchange` can re-evaluate it.
 *
 * Storing the raw bytes is what makes a re-run possible without a re-request:
 * an assertion evaluated twice against the same recorded exchange must give the
 * same answer, or the tool is measuring the network rather than the service.
 */
const remember = (
  store: SessionStore,
  now: () => Date,
  exchange: {
    readonly method: string;
    readonly url: string;
    readonly requestHeaders: Readonly<Record<string, string>>;
    readonly requestBody: Buffer | undefined;
    readonly response: HttpExchange | undefined;
    readonly durationMs: number;
    readonly error: string | undefined;
    readonly captureId: string | undefined;
  },
): ExchangeRecord =>
  store.addExchange({
    exchangeId: newId("exchange"),
    at: now().toISOString(),
    method: exchange.method,
    url: exchange.url,
    status: exchange.response?.status,
    statusText: exchange.response?.statusText,
    httpVersion: exchange.response?.httpVersion,
    requestHeaders: exchange.requestHeaders,
    responseHeaders: exchange.response?.headers ?? {},
    requestBody: exchange.requestBody,
    responseBody: exchange.response?.body,
    durationMs: exchange.durationMs,
    // A caller's own request body is sent whole and recorded whole; only the
    // response can arrive already cut short, by the transport's read limit.
    requestBodyTruncated: false,
    responseBodyTruncated: exchange.response?.bodyTruncated ?? false,
    error: exchange.error,
    captureId: exchange.captureId,
  });

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

export class WebService {
  constructor(private readonly options: WebServiceOptions) {}

  private get now(): () => Date {
    return this.options.now ?? ((): Date => new Date());
  }

  /**
   * One HTTP request, reported in full.
   *
   * `http_version: "3"` is refused rather than silently downgraded. Node's
   * standard library has no HTTP/3 client, and answering an HTTP/1.1 request
   * while the caller asked for HTTP/3 would be the worst possible outcome: a
   * green result for a transport that was never exercised.
   */
  async httpRequest(
    input: HttpRequestInput,
    recorder: EvidenceRecorder,
    signal: AbortSignal,
  ): Promise<{
    exchange_id: string;
    request: { method: string; url: string };
    status: number;
    status_text: string;
    http_version: string;
    request_http_version: string;
    headers: Record<string, string>;
    timing: ReturnType<typeof toTiming>;
    body: {
      bytes: number;
      content_type?: string;
      text?: string;
      base64?: string;
      truncated: boolean;
      decoded_as_text: boolean;
      digest: string;
    };
    redirects: { status: number; location: string }[];
    tls?: object;
  }> {
    if (input.http_version === "3") {
      throw new UvpFailure({
        code: "unsupported_target",
        message: "HTTP/3 is not supported by this client.",
        remediation: {
          action:
            "Retry with http_version=auto, 2, or 1.1. uvp speaks HTTP/3 only through a libuvcpp " +
            "service under test, not as a client.",
        },
      });
    }

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
      const timedOut = transportFailureKind(cause) === "timeout";
      throw new UvpFailure({
        code: timedOut ? "timeout" : "endpoint_unreachable",
        message: `${input.method} ${input.url} did not complete: ${message}`,
        remediation: {
          action: timedOut
            ? "Raise timeout_ms, or check whether the service is still starting up."
            : "Check that the service is listening on that host and port, then retry.",
        },
        details: { url: input.url, method: input.method, elapsed_ms: Date.now() - started },
      });
    });

    if (signal.aborted) {
      throw new UvpFailure({
        code: "cancelled",
        message: "The request was cancelled after it completed.",
        remediation: { action: "Re-run the call." },
      });
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
        tls_verified: tls?.verified ?? false,
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
   */
  async websocketProbe(
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
    recorder: EvidenceRecorder,
    signal: AbortSignal,
  ): Promise<{
    exchange_id: string;
    upgraded: boolean;
    handshake: {
      status: number;
      headers: Record<string, string>;
      negotiated_subprotocol?: string;
    };
    frames: {
      direction: "sent" | "received";
      opcode: "text" | "binary" | "ping" | "pong" | "close";
      bytes: number;
      text?: string;
      base64?: string;
      at_ms: number;
      truncated: boolean;
    }[];
    close?: { code?: number; reason?: string };
    closed_cleanly: boolean;
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

    if (!result.upgraded && result.handshake.status === 0) {
      throw new UvpFailure({
        code: "endpoint_unreachable",
        message: `${input.url} could not be reached: ${result.transportError ?? "no response"}.`,
        remediation: {
          action: "Check that the service is listening, and that the URL uses ws:// or wss://.",
        },
        details: { url: input.url },
      });
    }

    const record = remember(this.options.store, this.now, {
      method: "GET",
      url: input.url,
      requestHeaders: input.headers,
      requestBody: undefined,
      response: undefined,
      durationMs: result.elapsedMs,
      error: result.upgraded
        ? undefined
        : `upgrade rejected with status ${String(result.handshake.status)}`,
      captureId: undefined,
    });

    if (result.transportError !== undefined && result.upgraded) {
      recordUnknown(
        recorder,
        "Did the WebSocket connection stay healthy for the whole probe?",
        "resource_limit",
        { blockedBy: result.transportError },
      );
    }

    const frames = result.frames
      // The close handshake is reported through `close` rather than as traffic,
      // so the frame list is what the application exchanged.
      .filter((frame) => frame.opcode !== "close")
      .map((frame) => {
        const payload = framePayload(frame, 64 * 1024);
        return {
          direction: frame.direction,
          opcode: frame.opcode as "text" | "binary" | "ping" | "pong",
          bytes: frame.bytes,
          ...(payload.text === undefined ? {} : { text: payload.text }),
          ...(payload.base64 === undefined ? {} : { base64: payload.base64 }),
          at_ms: result.elapsedMs,
          truncated: payload.truncated,
        };
      });

    return {
      exchange_id: record.exchangeId,
      upgraded: result.upgraded,
      handshake: {
        status: result.handshake.status,
        headers: { ...result.handshake.headers },
        ...(result.handshake.negotiatedSubprotocol === undefined
          ? {}
          : { negotiated_subprotocol: result.handshake.negotiatedSubprotocol }),
      },
      frames,
      ...(result.close === undefined
        ? {}
        : {
            close: {
              ...(result.close.code === undefined ? {} : { code: result.close.code }),
              ...(result.close.reason === undefined ? {} : { reason: result.close.reason }),
            },
          }),
      closed_cleanly: result.closedCleanly,
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
      throw new UvpFailure({
        code: "cancelled",
        message: "The SOAP call was cancelled before its result was read.",
        remediation: { action: "Re-run the call." },
      });
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
