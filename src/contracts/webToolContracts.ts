import { z } from "zod";

import { defineTool } from "./toolContractTypes.js";
import { toolEnvelopeShape } from "./toolOutputSchemaPrimitives.js";
import { ASSERTION_KINDS } from "../domain/assertionKinds.js";

const exchangeIdSchema = z.string().regex(/^exc_[0-9a-f]{22}$/u);
const captureIdSchema = z.string().regex(/^cap_[0-9a-f]{22}$/u);

const headerMapSchema = z.record(z.string(), z.string());

const timingSchema = z.object({
  dns_ms: z.number().optional(),
  connect_ms: z.number().optional(),
  tls_ms: z.number().optional(),
  ttfb_ms: z.number().optional(),
  total_ms: z.number(),
});

/**
 * The HTTP primitive.
 *
 * One tool, not one per verb, and not one per protocol version. `http_version`
 * is a request parameter rather than a separate tool because the caller's
 * intent is identical across them; what changes is a capability of the
 * transport, which the result reports back.
 */
export const httpRequestContract = defineTool({
  name: "uvp_http_request",
  title: "Send an HTTP request",
  description:
    "Send one HTTP request and return the complete exchange: status, headers, body, negotiated " +
    "protocol version, TLS details, and a timing breakdown. Bodies are returned inline when they " +
    "are text and small, otherwise as a base64 payload with the byte count. " +
    "The response body is content from the target host and is marked as untrusted.",
  kind: "web",
  inputSchema: z.object({
    url: z.string().min(1).describe("Absolute URL, including scheme."),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).default("GET"),
    headers: headerMapSchema.default({}),
    body: z.string().optional(),
    body_encoding: z.enum(["utf8", "base64"]).default("utf8"),
    http_version: z
      .enum(["auto", "1.1", "2", "3"])
      .default("auto")
      .describe("Requested protocol version; `auto` negotiates. The result reports what was used."),
    follow_redirects: z
      .boolean()
      .default(false)
      .describe(
        "Follow 3xx responses. Off, a redirect is returned as the answer, with its Location.",
      ),
    max_redirects: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(5)
      .describe("Hops to follow before the last 3xx is returned as the result."),
    verify_tls: z.boolean().default(true),
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .default(30_000)
      .describe("Deadline for the whole call, redirect hops included."),
    /** Return at most this many body bytes; the remainder is reported as truncated. */
    max_body_bytes: z.number().int().min(1).default(1_048_576),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    exchange_id: exchangeIdSchema,
    request: z.object({ method: z.string(), url: z.string() }),
    status: z.number().int(),
    status_text: z.string(),
    /** The version actually used, which may differ from the one requested. */
    http_version: z.string(),
    request_http_version: z.string(),
    headers: headerMapSchema,
    timing: timingSchema,
    body: z.object({
      bytes: z.number().int(),
      content_type: z.string().optional(),
      text: z.string().optional(),
      base64: z.string().optional(),
      truncated: z.boolean(),
      /** True when the payload looks like text and was decoded as such. */
      decoded_as_text: z.boolean(),
      digest: z.string(),
    }),
    redirects: z.array(z.object({ status: z.number().int(), location: z.string() })),
    tls: z
      .object({
        protocol: z.string().optional(),
        cipher: z.string().optional(),
        subject: z.string().optional(),
        issuer: z.string().optional(),
        valid_from: z.string().optional(),
        valid_to: z.string().optional(),
        /** Verification outcome. `false` means the exchange happened anyway. */
        verified: z.boolean(),
        errors: z.array(z.string()),
      })
      .optional(),
  }),
  effects: {
    readsFilesystem: false,
    writesFilesystem: false,
    network: true,
    spawnsProcess: false,
    mutatesTarget: false,
  },
  returnsTargetContent: true,
  examples: [
    {
      description: "Fetch JSON over HTTP/1.1",
      input: { url: "http://127.0.0.1:8080/hello", http_version: "1.1" },
    },
    {
      description: "POST a body and do not follow redirects",
      input: {
        url: "https://api.example.com/orders",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"sku":"A1"}',
      },
    },
  ],
});

/**
 * WebSocket probe.
 *
 * Reports the handshake as an exchange and then the frames, because a failed
 * upgrade is diagnosable from the handshake response and a successful one is
 * not evidence that application frames work.
 */
export const websocketProbeContract = defineTool({
  name: "uvp_websocket_probe",
  title: "Probe a WebSocket endpoint",
  description:
    "Open a WebSocket, optionally send messages, collect frames until a stop condition is met, " +
    "then close. Returns the upgrade handshake separately from the frame log, so a rejected " +
    "upgrade is distinguishable from a connection that opened and then stayed silent.",
  kind: "web",
  inputSchema: z.object({
    url: z.string().min(1).describe("ws:// or wss:// URL."),
    headers: headerMapSchema.default({}),
    subprotocols: z.array(z.string()).default([]),
    send: z
      .array(
        z.object({
          payload: z.string(),
          encoding: z.enum(["utf8", "base64"]).default("utf8"),
          /** Wait this long after sending before the next frame is sent. */
          wait_ms: z.number().int().min(0).default(0),
        }),
      )
      .default([]),
    /** Stop after receiving this many frames, or when the timeout expires. */
    max_frames: z.number().int().min(1).default(10),
    idle_timeout_ms: z.number().int().min(1).default(5_000),
    verify_tls: z.boolean().default(true),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    exchange_id: exchangeIdSchema,
    upgraded: z.boolean(),
    handshake: z.object({
      status: z.number().int(),
      headers: headerMapSchema,
      negotiated_subprotocol: z.string().optional(),
    }),
    frames: z.array(
      z.object({
        direction: z.enum(["sent", "received"]),
        opcode: z.enum(["text", "binary", "ping", "pong", "close"]),
        bytes: z.number().int(),
        text: z.string().optional(),
        base64: z.string().optional(),
        at_ms: z.number().int(),
        truncated: z.boolean(),
      }),
    ),
    close: z
      .object({ code: z.number().int().optional(), reason: z.string().optional() })
      .optional(),
    closed_cleanly: z.boolean(),
  }),
  effects: {
    readsFilesystem: false,
    writesFilesystem: false,
    network: true,
    spawnsProcess: false,
    mutatesTarget: false,
  },
  returnsTargetContent: true,
  examples: [
    {
      description: "Echo one message and read the reply",
      input: {
        url: "ws://127.0.0.1:8080/echo",
        send: [{ payload: "ping" }],
        max_frames: 1,
      },
    },
  ],
});

/**
 * SOAP.
 *
 * Distinct from `uvp_http_request` because the intent is materially different:
 * the caller has a WSDL and wants an operation invoked, and expects SOAP
 * faults to be reported as protocol outcomes rather than HTTP failures.
 */
export const soapCallContract = defineTool({
  name: "uvp_soap_call",
  title: "Invoke a SOAP operation",
  description:
    "Invoke a SOAP 1.1 or 1.2 operation, building the envelope from parameters or accepting a " +
    "raw envelope. A SOAP fault is reported as a protocol-level result with its fault code and " +
    "detail, not as a transport error, even though the HTTP status is usually 500.",
  kind: "web",
  inputSchema: z.object({
    endpoint: z.string().min(1),
    soap_version: z.enum(["1.1", "1.2"]).default("1.1"),
    operation: z.string().optional().describe("Operation name, when building the envelope."),
    namespace: z.string().optional().describe("Target namespace for the operation."),
    parameters: z.record(z.string(), z.unknown()).default({}),
    raw_envelope: z.string().optional().describe("Sent verbatim; overrides operation/parameters."),
    soap_action: z.string().optional(),
    headers: headerMapSchema.default({}),
    timeout_ms: z.number().int().min(1).default(30_000),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    exchange_id: exchangeIdSchema,
    status: z.number().int(),
    /** `success` | `fault` | `transport_error` */
    outcome: z.enum(["success", "fault", "transport_error"]),
    fault: z
      .object({
        code: z.string().optional(),
        subcode: z.string().optional(),
        reason: z.string().optional(),
        detail: z.string().optional(),
      })
      .optional(),
    body: z.object({
      bytes: z.number().int(),
      text: z.string().optional(),
      truncated: z.boolean(),
      digest: z.string(),
    }),
    timing: timingSchema,
  }),
  effects: {
    readsFilesystem: false,
    writesFilesystem: false,
    network: true,
    spawnsProcess: false,
    mutatesTarget: false,
  },
  returnsTargetContent: true,
  examples: [
    {
      description: "Call a SOAP 1.2 operation",
      input: {
        endpoint: "https://svc.example.com/ws",
        soap_version: "1.2",
        operation: "GetQuote",
        namespace: "urn:example:quote",
        parameters: { symbol: "ACME" },
      },
    },
  ],
});

/**
 * Load test.
 *
 * Reports a distribution, never a single number. A mean without percentiles
 * hides exactly the behaviour a caller is asking about.
 */
export const loadTestContract = defineTool({
  name: "uvp_load_test",
  title: "Measure latency under concurrency",
  description:
    "Issue a fixed request for a bounded number of iterations across a fixed number of " +
    "concurrent workers, and return the latency distribution, throughput, status histogram, and " +
    "error breakdown. Bounded by request count and wall-clock budget, whichever comes first.",
  kind: "web",
  inputSchema: z.object({
    url: z.string().min(1),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
    headers: headerMapSchema.default({}),
    body: z.string().optional(),
    concurrency: z.number().int().min(1).max(512).default(8),
    requests: z.number().int().min(1).max(1_000_000).default(200),
    duration_ms: z.number().int().min(100).default(30_000),
    timeout_ms: z.number().int().min(1).default(10_000),
    warmup_requests: z.number().int().min(0).max(10_000).default(0),
    verify_tls: z.boolean().default(true),
    /**
     * The most individual timings kept for the response. The distribution is
     * computed from exactly those, and the count not kept is reported.
     */
    max_samples: z.number().int().min(1).max(1_000_000).default(10_000),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    requests_sent: z.number().int(),
    requests_completed: z.number().int(),
    requests_failed: z.number().int(),
    duration_ms: z.number().int(),
    throughput_rps: z.number(),
    latency_ms: z.object({
      min: z.number(),
      p50: z.number(),
      p90: z.number(),
      p95: z.number(),
      p99: z.number(),
      max: z.number(),
      mean: z.number(),
      stddev: z.number(),
    }),
    status_histogram: z.record(z.string(), z.number().int()),
    /** Failures grouped by cause, so a partial outage is visible as a shape. */
    errors: z.array(z.object({ kind: z.string(), count: z.number().int(), sample: z.string() })),
    /** True when the run ended at the iteration count rather than the clock. */
    completed_by_count: z.boolean(),
    /** The individual timings every number above was computed from, in order. */
    samples: z.array(z.number()),
    samples_retained: z.number().int(),
    samples_dropped: z.number().int(),
  }),
  effects: {
    readsFilesystem: false,
    writesFilesystem: false,
    network: true,
    spawnsProcess: false,
    mutatesTarget: true,
  },
  examples: [
    {
      description: "Sustain 64 concurrent GETs for up to 10 seconds",
      input: {
        url: "http://127.0.0.1:8080/hello",
        concurrency: 64,
        requests: 100000,
        duration_ms: 10000,
      },
    },
  ],
});

/**
 * Capture.
 *
 * A capture session is a live, session-scoped observation. Starting one is a
 * separate authority from reading it, so they are separate tools.
 */
export const captureStartContract = defineTool({
  name: "uvp_capture_start",
  title: "Start capturing traffic",
  description:
    "Begin a capture session on a local listening port and forward matching traffic to an " +
    "upstream origin. Returns the proxy endpoint to point a client at. The session is owned by " +
    "the current uvp session and is reported in subsequent capture reads.",
  kind: "web",
  inputSchema: z.object({
    listen_port: z.number().int().min(1).max(65535).default(8888),
    upstream: z.string().optional().describe("Origin to forward to; omit for a transparent proxy."),
    filter: z
      .object({
        hosts: z.array(z.string()).default([]),
        methods: z.array(z.string()).default([]),
        path_prefix: z.string().optional(),
      })
      .default({ hosts: [], methods: [] }),
    /** Stop the capture automatically once this many exchanges are recorded. */
    max_exchanges: z.number().int().min(1).optional(),
    auto_stop_ms: z.number().int().min(1000).optional(),
    /**
     * The most bytes recorded per direction per exchange. Not the size a request
     * may be — a longer body is still forwarded whole — only how much of it is
     * kept for reading back.
     */
    max_body_bytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024)
      .default(1024 * 1024),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    capture_id: captureIdSchema,
    listen_port: z.number().int(),
    proxy_url: z.string(),
    upstream: z.string().optional(),
    started_at: z.string(),
    max_body_bytes: z.number().int(),
  }),
  effects: {
    readsFilesystem: false,
    writesFilesystem: false,
    network: true,
    spawnsProcess: false,
    mutatesTarget: true,
  },
  examples: [
    {
      description: "Capture on 8888 in front of a local service",
      input: { listen_port: 8888, upstream: "http://127.0.0.1:8080" },
    },
  ],
});

export const captureReadContract = defineTool({
  name: "uvp_capture_read",
  title: "Read captured traffic",
  description:
    "List the exchanges recorded by a capture session, optionally hydrating full request and " +
    "response payloads. Reports how many exchanges were held back by the read limit and how many " +
    "bodies the recording limit cut short, so an empty-looking or short result is never confused " +
    "with traffic that was not there.",
  kind: "web",
  inputSchema: z.object({
    capture_id: captureIdSchema.optional().describe("Defaults to the most recent session."),
    since_id: exchangeIdSchema.optional(),
    limit: z.number().int().min(1).max(1000).default(100),
    include_payloads: z.boolean().default(false),
    stop: z.boolean().default(false).describe("Stop the capture session after reading."),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    capture_id: captureIdSchema,
    running: z.boolean(),
    exchanges: z.array(
      z.object({
        exchange_id: exchangeIdSchema,
        at: z.string(),
        method: z.string(),
        url: z.string(),
        status: z.number().int().optional(),
        request_bytes: z.number().int(),
        response_bytes: z.number().int(),
        request_body_truncated: z.boolean(),
        response_body_truncated: z.boolean(),
        duration_ms: z.number().int(),
        request_body: z.string().optional(),
        response_body: z.string().optional(),
        error: z.string().optional(),
      }),
    ),
    total_recorded: z.number().int(),
    withheld_by_limit: z.number().int(),
    /** The per-direction recording limit this session was started with. */
    body_limit_bytes: z.number().int(),
    /** How many of the returned exchanges carry a body cut to that limit. */
    bodies_truncated: z.number().int(),
  }),
  effects: {
    readsFilesystem: true,
    writesFilesystem: false,
    network: false,
    spawnsProcess: false,
    mutatesTarget: false,
  },
  returnsTargetContent: true,
  examples: [
    {
      description: "Read the last 20 exchanges with payloads",
      input: { limit: 20, include_payloads: true },
    },
  ],
});

/**
 * Assertions over a captured exchange.
 *
 * Kept separate from the request primitive so that a check can be re-evaluated
 * against a stored exchange without repeating the network call — which is also
 * what makes a verification pass re-runnable against a recorded baseline.
 */
export const assertExchangeContract = defineTool({
  name: "uvp_assert_exchange",
  title: "Assert over a recorded exchange",
  description:
    "Evaluate assertions against an exchange recorded earlier in this session, without sending " +
    "any traffic. Returns each assertion's outcome with the observed value behind it, so a " +
    "failure shows what was actually there rather than only that it differed.",
  kind: "web",
  inputSchema: z.object({
    exchange_id: exchangeIdSchema,
    assertions: z
      .array(
        z.object({
          // The vocabulary is declared once, in `domain`, because the evaluator,
          // this contract, and `uvp_verify`'s all name the same closed set.
          kind: z.enum(ASSERTION_KINDS),
          target: z.string().optional().describe("Header name, JSONPath, or regex, as applicable."),
          expected: z.unknown().optional(),
          negate: z.boolean().default(false),
        }),
      )
      .min(1),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    exchange_id: exchangeIdSchema,
    passed: z.number().int(),
    failed: z.number().int(),
    results: z.array(
      z.object({
        kind: z.string(),
        target: z.string().optional(),
        passed: z.boolean(),
        /** What was actually observed, in the form the assertion compared against. */
        observed: z.unknown(),
        expected: z.unknown().optional(),
        message: z.string(),
      }),
    ),
  }),
  effects: {
    readsFilesystem: true,
    writesFilesystem: false,
    network: false,
    spawnsProcess: false,
    mutatesTarget: false,
  },
  examples: [
    {
      description: "Check a recorded exchange's status and a JSON field",
      input: {
        exchange_id: "exc_0000000000000000000000",
        assertions: [
          { kind: "status_equals", expected: 200 },
          { kind: "body_json_path_equals", target: "$.message", expected: "Hello, AI" },
        ],
      },
    },
  ],
});
