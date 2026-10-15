import { decodeBody, type HttpExchange } from "./httpClient.js";
import { cancelledFailure, UvpFailure } from "../domain/errors.js";
import { sha256 } from "../domain/identity.js";
import {
  coveragePartial,
  endpointSource,
  record,
  type EvidenceRecorder,
} from "./evidenceHelpers.js";
import { rememberExchange } from "./exchangeRecord.js";
import type { SessionStore } from "./sessionStore.js";
import type { HttpRequestOutput, ToolTlsReport } from "./httpToolOutput.js";
import type {
  NativeHttp3Outcome,
  NativeHttp3Probe,
  NativeHttp3Report,
} from "./NativeHttp3Probe.js";

/**
 * `uvp_http_request` over HTTP/3.
 *
 * Node has no HTTP/3 client, so this is the one protocol version uvp cannot ask
 * from its own process. It asks through the native probe instead — libuvcpp's own
 * h3 client, driven by `native/uvcpp-probe`, which is the same stack a generated
 * service links against. That is what makes the answer worth having: the client
 * and the server under test come from one implementation, so a disagreement
 * between them is a finding rather than two projects' readings of a spec.
 *
 * It lives here rather than inside `WebService.httpRequest` because almost nothing
 * is shared. There is no connection pool, no redirect chain, no proxy environment,
 * no per-phase timing and no certificate chain — the C ABI reports a handshake and
 * a response and nothing underneath either. What the two paths *do* share is the
 * tool's output, which is why that is a named type rather than two branches
 * agreeing by inspection.
 *
 * Three refusals, each of which would otherwise become a result about a transport
 * that was never used:
 *
 *   - `http://` — QUIC has no cleartext mode, so there is no such request.
 *   - `verify_tls: true` — the C ABI's QUIC client verifies against a CA bundle it
 *     is handed or not at all. There is no system-trust-store path in that layer
 *     and this tool has no input for a bundle, so `verified` is not a claim it can
 *     make. It is the default, so the refusal names the way through.
 *   - `follow_redirects: true` — the probe makes one request. Following a hop would
 *     mean a second connection and a chain assembled from evidence in two
 *     processes; refused rather than answered with the first hop's 3xx as though
 *     it were the end of the chain.
 *
 * A fourth thing that is not a refusal but is a failure: a host the probe cannot
 * resolve. That arrives as a report — the probe deliberately reports it rather than
 * refusing it — and is mapped below to `target_unavailable`, because a name that
 * does not resolve is a fact about the target.
 */

/** What this path needs of the http request, which is not all of it. */
export interface Http3RequestInput {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly body_encoding: "utf8" | "base64";
  readonly follow_redirects: boolean;
  readonly verify_tls: boolean;
  readonly timeout_ms: number;
  readonly max_body_bytes: number;
}

/**
 * The session this exchange is recorded into.
 *
 * Bound at construction rather than taken per call. The client is built for one
 * exchange — `WebService` constructs it inside the request it serves — so a
 * `store` argument on `request` would be a parameter that can only ever hold what
 * the constructor already has, and `WebService`'s own `httpRequest` takes the
 * recorder and the signal and nothing else for the same reason.
 */
export class Http3Client {
  constructor(
    private readonly probe: NativeHttp3Probe,
    private readonly store: SessionStore,
    private readonly now: () => Date,
    private readonly recorder: EvidenceRecorder,
  ) {}

  async request(input: Http3RequestInput, signal: AbortSignal): Promise<HttpRequestOutput> {
    refuse(input);

    const parsed = new URL(input.url);
    const body =
      input.body === undefined
        ? undefined
        : Buffer.from(input.body, input.body_encoding === "base64" ? "base64" : "utf8");

    const outcome = await this.probe.probe(
      {
        url: input.url,
        // The facts uvp's own URI parser produced, rather than the URL again for
        // the probe to take apart. One owner for "what this URL means".
        host: parsed.hostname,
        port: parsed.port === "" ? 443 : Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        authority: undefined,
        method: input.method,
        headers: Object.entries(input.headers).map(([name, value]) => ({ name, value })),
        body: body === undefined ? "" : body.toString("utf8"),
        caFile: undefined,
        // One deadline, not two. The probe also has an idle clock, and setting it
        // below the caller's `timeout_ms` would end a run for silence while the
        // deadline the caller actually set has not passed — so a service that took
        // 20 seconds to answer would be reported as one that went quiet at 15. The
        // run ends when the caller said it does, and *why* it ended is in the
        // report either way.
        idleTimeoutMs: input.timeout_ms,
        totalTimeoutMs: input.timeout_ms,
        maxBodyBytes: input.max_body_bytes,
      },
      signal,
    );

    if (outcome.kind === "cancelled") {
      throw cancelledFailure(
        "The HTTP/3 request was cancelled; the probe was killed and observed nothing more.",
      );
    }
    if (outcome.kind !== "report") {
      throw http3Failure(outcome, input);
    }

    return this.assemble(input, outcome.report, parsed);
  }

  /** The tool's output, from a report that arrived and answered. */
  private assemble(
    input: Http3RequestInput,
    report: NativeHttp3Report,
    parsed: URL,
  ): HttpRequestOutput {
    if (!report.answered || report.status === undefined) {
      throw noResponseFailure(report, input);
    }

    const exchange = toExchange(report, input);
    const stored = rememberExchange(this.store, this.now, {
      method: input.method,
      url: input.url,
      requestHeaders: input.headers,
      requestBody: input.body === undefined ? undefined : Buffer.from(input.body, "utf8"),
      response: exchange,
      durationMs: exchange.timing.totalMs,
      error: undefined,
      captureId: undefined,
      // The names the probe asked for, carried with the record so that a header
      // assertion on anything else says "not looked at" rather than "absent".
      responseHeadersObserved: report.headersObserved,
    });

    const contentType = exchange.headers["content-type"];
    const decoded = decodeBody(exchange.body, contentType);
    const limitations = http3Limitations(report, parsed);

    record(this.recorder, {
      kind: "exchange",
      subject: { method: input.method, url: input.url, exchange_id: stored.exchangeId },
      observed: {
        status: exchange.status,
        http_version: exchange.httpVersion,
        response_bytes: exchange.bodyBytes,
        alpn: report.alpn,
      },
      derived: {
        tls_verification: "not_checked",
        // Reported rather than folded into `truncated`: the body was not shortened,
        // it was not carried, and a caller comparing byte counts against the Node
        // path is comparing two different things when this is true.
        body_omitted: report.bodyOmitted !== undefined,
        headers_observed: report.headersObserved.length,
        ...(report.responseError === 0 ? {} : { response_error: report.responseError }),
      },
      // The header set is the incomplete part, stated as partial over the names that
      // were read rather than as complete over a scope that was not examined.
      coverage: coveragePartial(
        "HTTP/3 exchange",
        `response headers outside ${report.headersObserved.join(", ")} were not read`,
      ),
      sources: [endpointSource(input.url)],
      limitations,
    });

    return {
      exchange_id: stored.exchangeId,
      request: { method: input.method, url: input.url },
      status: exchange.status,
      status_text: exchange.statusText,
      http_version: exchange.httpVersion,
      request_http_version: exchange.requestHttpVersion,
      headers: { ...exchange.headers },
      // Only the whole-call duration. The probe polls the h3 connection every 2 ms
      // because the stack has no ready callback, so a DNS, connect or first-byte
      // figure measured on top of that would be a number about the poll interval
      // wearing the name of a phase.
      timing: { total_ms: exchange.timing.totalMs },
      body: {
        bytes: exchange.bodyBytes,
        ...(contentType === undefined ? {} : { content_type: contentType }),
        ...(decoded.text === undefined ? {} : { text: decoded.text }),
        ...(decoded.base64 === undefined ? {} : { base64: decoded.base64 }),
        // The probe returns a body whole or not at all, so an absent body here means
        // it was over the cap rather than cut to it.
        truncated: report.bodyOmitted !== undefined,
        decoded_as_text: decoded.decodedAsText,
        digest: sha256(exchange.body),
      },
      // Always empty, and not because nothing redirected: `follow_redirects: true`
      // was refused, so a 3xx is the answer and its Location is in `headers`.
      redirects: [],
      tls: tlsReport(report),
    };
  }
}

/**
 * The three requests this path cannot serve, said before anything is spawned.
 *
 * Before, and not after, because each would otherwise produce a report about a
 * request the caller did not make — and the failure mode is not an error but a
 * green result about something else.
 */
const refuse = (input: Http3RequestInput): void => {
  if (!input.url.startsWith("https://")) {
    throw new UvpFailure({
      code: "invalid_request",
      message: `HTTP/3 needs an https:// URL; "${input.url}" is not one.`,
      remediation: {
        action:
          "QUIC has no cleartext mode, so there is no http:// request to make over HTTP/3. Use " +
          "https://, or ask over HTTP/1.1 or HTTP/2 with http_version=auto or 1.1.",
      },
      details: { url: input.url, http_version: "3" },
    });
  }
  if (input.verify_tls) {
    throw new UvpFailure({
      code: "unsupported_target",
      message:
        "HTTP/3 over this client cannot verify the peer's certificate, and verify_tls is on.",
      remediation: {
        action:
          "Pass verify_tls: false (CLI: --no-tls) to run the request and have the result report " +
          "`verification: not_checked` rather than claim a chain it never examined. uvp's QUIC " +
          "client verifies only against a CA bundle it is handed, and this tool has no input for " +
          "one, so there is no way for it to say `verified`.",
      },
      details: { url: input.url, http_version: "3", verify_tls: true },
    });
  }
  if (input.follow_redirects) {
    throw new UvpFailure({
      code: "invalid_request",
      message: "HTTP/3 requests do not follow redirects.",
      remediation: {
        action:
          "Pass follow_redirects: false (the default) and read the 3xx status and its Location from " +
          "the result; the QUIC client makes one request per run.",
      },
      details: { url: input.url, http_version: "3" },
    });
  }
};

/**
 * What can be said about the certificate, which is not much and is said exactly.
 *
 * `not_checked` rather than `verified`: this request was made without a CA bundle
 * because that is the only way this layer can make one, and no chain was examined.
 * `reason` says that in the caller's words rather than leaving a bare enum to be
 * read as "uvp checked and it was fine".
 */
const tlsReport = (report: NativeHttp3Report): ToolTlsReport => ({
  verification: "not_checked",
  reason:
    report.handshakeCompleted && report.alpn === "h3"
      ? "The QUIC handshake completed with ALPN h3. No certificate was examined: uvp's QUIC client verifies against a CA bundle it is handed or not at all, and this request was made without one."
      : "No certificate was examined: uvp's QUIC client verifies against a CA bundle it is handed or not at all, and this request was made without one.",
});

/**
 * The failure for a run that produced no response.
 *
 * The distinctions are the report's own facts rather than a guess at them: whether
 * the handshake completed says which half of the request was reached, which is the
 * difference between a target that could not be reached and an endpoint that took
 * the request and said nothing — two findings whose next steps point in opposite
 * directions. And `stop_reason: "total"` says the caller's own deadline expired,
 * which is a `timeout` rather than a claim about the service at all.
 */
const noResponseFailure = (report: NativeHttp3Report, input: Http3RequestInput): UvpFailure => {
  if (report.stopReason === "total") {
    return new UvpFailure({
      code: "timeout",
      message: `${input.method} ${input.url} did not answer over HTTP/3 within ${String(input.timeout_ms)} ms.`,
      remediation: {
        action: "Raise timeout_ms, or check whether the service is still starting up.",
      },
      details: {
        url: input.url,
        method: input.method,
        requested_http_version: "3",
        elapsed_ms: report.totalMs,
        handshake_completed: report.handshakeCompleted,
        request_sent: report.requestSent,
      },
    });
  }

  const transport =
    report.error === undefined
      ? report.handshakeCompleted
        ? "the connection was established and no response arrived"
        : "the QUIC handshake did not complete"
      : `${report.error.what} (code ${String(report.error.code)})`;

  return new UvpFailure({
    code: report.handshakeCompleted ? "endpoint_unreachable" : "target_unavailable",
    message: `${input.method} ${input.url} did not complete over HTTP/3: ${transport}.`,
    remediation: {
      action: report.handshakeCompleted
        ? "Check that the service has a route for this path and that it speaks HTTP/3 on this UDP port."
        : "Check that the host resolves, that a QUIC service is listening on this UDP port, and that it serves TLS 1.3 — QUIC mandates it.",
    },
    details: {
      url: input.url,
      method: input.method,
      requested_http_version: "3",
      elapsed_ms: report.totalMs,
      handshake_completed: report.handshakeCompleted,
      handshake_status: report.handshakeStatus,
      alpn: report.alpn,
      request_sent: report.requestSent,
      ...(report.lastSendError === undefined ? {} : { last_send_error: report.lastSendError }),
      ...(report.error === undefined ? {} : { reason_code: report.error.code }),
    },
  });
};

/**
 * The probe's own refusals and failures, as the failure a caller acts on.
 *
 * Deliberately not shared with the WebSocket path's mapping: the words differ
 * because the fixes do. A probe that cannot start QUIC has no counterpart in one
 * that cannot start a WebSocket, and one message between them would have a caller
 * reading about the wrong transport.
 */
const http3Failure = (
  outcome: Exclude<NativeHttp3Outcome, { kind: "report" }>,
  input: Http3RequestInput,
): UvpFailure => {
  switch (outcome.kind) {
    case "stack-unavailable":
      return new UvpFailure({
        code: "toolchain_unavailable",
        message:
          outcome.state === "unavailable"
            ? `uvp's native probe cannot make HTTP/3 requests on this host: ${outcome.reason}.`
            : `Whether the native probe can make HTTP/3 requests on this host could not be determined: ${outcome.reason}.`,
        remediation: {
          action:
            "Build the probe with `npm run build:native-probe` — it needs a C++ toolchain and a " +
            "libuvcpp built with UVCPP_ENABLE_CAPI=ON — point UVP_NATIVE_PROBE at one you have, or " +
            "ask over HTTP/1.1 or HTTP/2 instead.",
        },
        details: {
          state: outcome.state,
          reason: outcome.reason,
          ...(outcome.path === undefined ? {} : { path: outcome.path }),
          url: input.url,
          http_version: "3",
        },
      });
    case "request-refused":
      // The probe's own words. Every path that reaches here is a request uvp built
      // and this stack will not serve, and the refusal names the part. A host that
      // does not resolve is deliberately *not* one of these: the probe reports it
      // instead of refusing it, so it arrives above as a target that never
      // handshook rather than as a request uvp got wrong.
      return new UvpFailure({
        code: "invalid_request",
        message: `The native HTTP/3 probe refused this request: ${outcome.message}.`,
        remediation: { action: "Correct the part the probe named, then retry." },
        details: { url: input.url, http_version: "3" },
      });
    case "cancelled":
      return cancelledFailure(
        "The HTTP/3 request was cancelled; the probe was killed and observed nothing more.",
      );
    case "probe-failed":
      return new UvpFailure({
        code: "execution_failure",
        message: `The native HTTP/3 probe produced no report: ${outcome.message}.`,
        remediation: {
          action:
            "Check that the probe binary at that path runs (`uvcpp-probe --version`), then re-run the request.",
        },
        details: {
          url: input.url,
          http_version: "3",
          ...(outcome.detail === "" ? {} : { probe_said: outcome.detail }),
        },
      });
  }
};

/**
 * One report, as the exchange the rest of this layer already knows how to hold.
 *
 * `statusText` is empty rather than invented. HTTP/2 and HTTP/3 dropped the reason
 * phrase, so there is no text to report and a synthesised "OK" would be a string
 * this stack never sent — the same empty string the Node path reports for its own
 * HTTP/2 responses, which is why the two agree here by construction.
 *
 * `bodyTruncated` is not `body.length < bodyBytes`; see the note in `assemble`.
 */
const toExchange = (report: NativeHttp3Report, input: Http3RequestInput): HttpExchange => {
  const body = Buffer.from(report.body, "utf8");
  return {
    url: input.url,
    method: input.method,
    status: report.status ?? 0,
    statusText: "",
    httpVersion: "3",
    requestHttpVersion: "3",
    headers: { ...report.headers },
    body,
    bodyBytes: report.bodyBytes,
    bodyTruncated: report.bodyOmitted !== undefined,
    // The four per-phase fields are `undefined` rather than omitted: this layer
    // reports phases with an explicit absent value everywhere, and the C ABI
    // offers no phase to read — the probe polls the h3 connection because the
    // stack has no ready callback, so a "DNS time" measured over that poll would
    // be a number about the poll interval.
    timing: {
      dnsMs: undefined,
      connectMs: undefined,
      tlsMs: undefined,
      ttfbMs: undefined,
      totalMs: report.totalMs,
    },
    // Absent rather than synthetic: this layer examined no certificate, and the
    // tool's own `tls` block reports that in the four-state vocabulary.
    tls: undefined,
    redirects: [],
  };
};

/**
 * What this call did not observe, in the words a caller reading its result needs.
 *
 * Every line but the last two is a property of the stack rather than of this run,
 * so they are the same on every HTTP/3 call — which is the point. A caller
 * comparing an h3 result with an h1 one has to be able to tell which differences
 * are the service's and which are the client's.
 */
export const http3Limitations = (report: NativeHttp3Report, parsed: URL): readonly string[] => [
  `Only the response headers listed in \`headers\` were read (${report.headersObserved.join(", ")}); the libuvcpp C ABI reads one response header at a time and has no call that lists them, so a name outside that set was not looked at rather than absent.`,
  "No certificate was examined: uvp's QUIC client verifies against a CA bundle it is handed or not at all, so the result reports `not_checked` rather than a chain.",
  "The response body is returned whole or not at all — this stack has no partial body read — so a body over max_body_bytes arrives empty with its real byte count in `body.bytes`.",
  "Timings are the whole call only, with a 2 ms floor: the h3 connection reports no ready callback, so the probe polls.",
  `HTTP/3 has no reason phrase, so status_text is empty; the status code is in \`status\`. This request went to ${parsed.host}.`,
  ...(report.responseError === 0
    ? []
    : [
        `The request ended with status ${String(report.responseError)} rather than cleanly; the response head and any body above are what arrived before it did.`,
      ]),
  ...(report.abandoned
    ? [
        "The probe's client loop never returned, so its report was written out from under a run that was still parked; whatever the peer sent after the last recorded fact was never read.",
      ]
    : []),
];
