import { z } from "zod";

import { defineTool } from "./toolContractTypes.js";
import { toolEnvelopeShape } from "./toolOutputSchemaPrimitives.js";
import { ASSERTION_KINDS } from "../domain/assertionKinds.js";
import { verdictStatusSchema } from "../domain/verdict.js";

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
    "protocol version, TLS details, and a timing breakdown. A body comes back as text with its " +
    "byte count and a digest, and a body whose text is not its bytes carries those bytes beside " +
    "the text as base64, with `text_lossy` naming why the two differ. " +
    "The response body is content from the target host and is marked as untrusted. " +
    "HTTP/3 is answered through libuvcpp's own QUIC client in a separate probe process — " +
    "the same stack a service from `uvp init` links against — so the result says which " +
    "certificate state applies and lists what that client could not read.",
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
      .describe(
        "Requested protocol version; `auto` negotiates. The result reports what was used. " +
          "`3` runs over QUIC through the native probe rather than in this process: it needs " +
          "an https:// URL, `verify_tls: false`, and `follow_redirects: false`, and reports " +
          "the response headers it read by name rather than the whole set.",
      ),
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
    /**
     * Return at most this many body bytes; the remainder is reported as truncated.
     *
     * The same input, and the same two-number rule, as `uvp_soap_call`'s envelope
     * cap. This one also bounds what the client reads before the transport's own
     * limit does; there it bounds only what is handed over, because a SOAP fault is
     * parsed from the whole envelope either way.
     */
    max_body_bytes: z
      .number()
      .int()
      .min(1)
      .default(1_048_576)
      .describe("Return at most this many body bytes; the remainder is reported as truncated."),
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
      /**
       * The body's bytes, base64-encoded, present exactly when `text` is not
       * them: a body that is not text, or one whose text is a lossy decode of it.
       * When both are present, read `text` for the words and this for the body —
       * `text_lossy` says why they differ, and the bytes here are the ones that
       * text was decoded from, so what the decode replaced can be recovered from
       * this answer without a second call.
       */
      base64: z.string().optional(),
      truncated: z.boolean(),
      /**
       * True when the payload looks like text and was decoded as such — which,
       * with `text_lossy` present, means a text that is not the bytes beside it.
       */
      decoded_as_text: z.boolean(),
      /**
       * Why the text is not the body's bytes, when it is not. Absent means
       * re-encoding the text returns the bytes exactly, so a caller may compare it
       * against `digest`.
       *
       * `truncated` — a cap cut the body inside a character, so the loss is the
       *   cap's and the peer sent nothing invalid. A cut on a character boundary
       *   leaves this absent, because there was nothing to lose.
       * `invalid-utf8` — the peer sent bytes that are not UTF-8, so the text has
       *   replacement characters where they were. Those bytes come with the answer
       *   as `base64`, which is present whenever this field is.
       *
       * The two are separate answers because only one of them is the peer's
       * doing, and because a body cut mid-character is the ordinary case for a
       * capped body rather than a finding about the service. Same vocabulary as
       * the WebSocket frames' `text_omitted`.
       */
      text_lossy: z.enum(["truncated", "invalid-utf8"]).optional(),
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
        /**
         * What happened to the certificate, in four states rather than two.
         *
         * `verified` — this client required a chain and the peer had one.
         * `failed` — it required one and the peer's did not validate. A
         *   completed exchange does not normally carry this, because a rejected
         *   chain stops the exchange and arrives as a failure instead; it is
         *   modelled because the two are different claims and only one of them
         *   can be made here.
         * `not_checked` — `verify_tls` was false for this request, so nothing
         *   was enforced. The chain was still validated; `reason` says what
         *   OpenSSL found, which is what turning verification off lets you see.
         * `undetermined` — this client required a chain and could not read the
         *   result. Distinct from `failed` for the same reason a probe that
         *   cannot run is distinct from an absent feature.
         */
        verification: z.enum(["verified", "failed", "not_checked", "undetermined"]),
        /** OpenSSL's own spelling of what was wrong with the chain, when it said. */
        reason: z.string().optional(),
      })
      .optional(),
  }),
  effects: {
    // `stack`-style conditionality is not expressible in a closed set of booleans,
    // and this contract is now in the same position `uvp_websocket_probe` was in
    // when `stack: "libuvcpp"` arrived: only `http_version: "3"` starts a process —
    // Node has no HTTP/3 client, so that one version is asked through the native
    // probe — and every other version is answered in this process. A caller that
    // reads this to decide whether the tool starts a process is better served by a
    // yes it may not use than by a no that is not always true.
    readsFilesystem: false,
    writesFilesystem: false,
    network: true,
    spawnsProcess: true,
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
 *
 * Two stacks can answer. The default speaks the protocol in-process and sees the
 * whole handshake response; the other drives libuvcpp's own WebSocket client
 * through its C ABI — the stack a generated service links against — and sees
 * less of it. The result says which one answered and carries the list of things
 * that stack could not observe, so a missing field is never a field that was
 * quietly filled in.
 */
export const websocketProbeContract = defineTool({
  name: "uvp_websocket_probe",
  title: "Probe a WebSocket endpoint",
  description:
    "Open a WebSocket, optionally send messages, collect frames until a stop condition is met, " +
    "then close. Returns the upgrade handshake separately from the frame log, so a rejected " +
    "upgrade is distinguishable from a connection that opened and then stayed silent. Each " +
    "expected frame is answered as matched or not, because a caller comparing strings against " +
    "the frame log is a second implementation of the same question. `stack` chooses which " +
    "WebSocket client runs the probe: `node` reports the handshake status and headers, while " +
    "`libuvcpp` probes through the C ABI of the libuvcpp that uvp's own services link against " +
    "and reports what that stack can see — no status line, no headers, and no ping or pong " +
    "frames, which it lists as not observable rather than omitting silently.",
  kind: "web",
  inputSchema: z.object({
    url: z.string().min(1).describe("ws:// or wss:// URL."),
    stack: z
      .enum(["node", "libuvcpp"])
      .default("node")
      .describe(
        "Which WebSocket client runs the probe. `libuvcpp` runs a separate probe process and " +
          "cannot do wss://, request headers, subprotocols, or a paced send.",
      ),
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
    /**
     * Text each of which must appear in a received frame. Matched against
     * received frames only: a frame this probe sent is not evidence that the
     * peer spoke.
     */
    expect: z.array(z.string().min(1)).default([]),
    /** Stop after receiving this many frames, or when the timeout expires. */
    max_frames: z.number().int().min(1).default(10),
    idle_timeout_ms: z.number().int().min(1).default(5_000),
    verify_tls: z.boolean().default(true),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    exchange_id: exchangeIdSchema,
    /** Which client answered. The two do not observe the same things. */
    stack: z.enum(["node", "libuvcpp"]),
    upgraded: z.boolean(),
    /**
     * Absent when the stack that ran the probe does not see the response — the
     * libuvcpp C ABI reports a completed upgrade without its status line or
     * headers, and reports a failed one as a transport status.
     */
    handshake: z
      .object({
        status: z.number().int(),
        headers: headerMapSchema,
        negotiated_subprotocol: z.string().optional(),
      })
      .optional(),
    frames: z.array(
      z.object({
        direction: z.enum(["sent", "received"]),
        opcode: z.enum(["text", "binary", "ping", "pong", "close"]),
        bytes: z.number().int(),
        text: z.string().optional(),
        base64: z.string().optional(),
        /**
         * Why a text frame carries no `text`. `truncated` when the payload was
         * longer than the probe's per-frame limit, `invalid-utf8` when it is not
         * text at all — decoding either would invent bytes the peer never sent.
         */
        text_omitted: z.enum(["truncated", "invalid-utf8"]).optional(),
        /** Milliseconds from the start of the probe to this frame. */
        at_ms: z.number().int(),
        truncated: z.boolean(),
      }),
    ),
    /** One entry per expected frame, in the order the expectations were given. */
    expectations: z.array(
      z.object({
        text: z.string(),
        /** False when no received frame contained this text. */
        matched: z.boolean(),
        /** Index into `frames` of the received frame that satisfied it. */
        matched_frame_index: z.number().int().optional(),
      }),
    ),
    /** False when an expected frame never arrived. An empty `expect` is met. */
    expectations_met: z.boolean(),
    /** Why the connection did not stay healthy, when it did not. */
    transport_error: z.string().optional(),
    close: z
      .object({ code: z.number().int().optional(), reason: z.string().optional() })
      .optional(),
    closed_cleanly: z.boolean(),
    /**
     * What the stack that ran the probe cannot observe, in its own words.
     *
     * Present when the chosen stack has blind spots, which is what makes an
     * absent field readable: a caller can tell "the peer sent nothing" from "this
     * client cannot see it".
     */
    not_observable: z.array(z.string()).optional(),
    /**
     * True when the probe process had to be killed at its deadline rather than
     * ending by itself. Everything after the last recorded frame is then unknown
     * rather than absent.
     */
    abandoned: z.boolean().optional(),
  }),
  effects: {
    readsFilesystem: false,
    writesFilesystem: false,
    network: true,
    // Unconditionally true, although only `stack: "libuvcpp"` starts a process.
    // The effect set is a closed set of booleans and cannot say "sometimes", and a
    // caller that reads this to decide whether the tool starts a process is
    // better served by a yes it may not use than by a no that is not always true.
    spawnsProcess: true,
    mutatesTarget: false,
  },
  returnsTargetContent: true,
  examples: [
    {
      description: "Echo one message and read the reply",
      input: {
        url: "ws://127.0.0.1:8080/echo",
        send: [{ payload: "ping" }],
        expect: ["pong"],
        max_frames: 1,
      },
    },
    {
      description: "Probe with the stack generated services link against",
      input: { url: "ws://127.0.0.1:8080/echo", stack: "libuvcpp", send: [{ payload: "ping" }] },
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
    /**
     * Hand over at most this many bytes of the response envelope, cut before
     * decoding; the remainder is reported as truncated.
     *
     * A byte count rather than the character count the fixed cap used to be: a cut
     * between code units can split a surrogate pair — a loss no field here can name
     * — while a cut between bytes can only land inside a character, which is exactly
     * what `text_lossy: "truncated"` reports. The cut this makes, the decode
     * `text_lossy` is about and the bytes `base64` carries are one buffer.
     *
     * The envelope is read whole whatever this says, because the fault is parsed
     * from all of it, and the transport's own read limit caps it before this does
     * — so this bounds what you are handed, not what the call reads. Asking for
     * more bytes than the envelope has is therefore not an error and not a
     * silence: the whole envelope arrives, with `truncated` false.
     */
    max_body_bytes: z
      .number()
      .int()
      .min(1)
      .default(64 * 1024)
      .describe(
        "Hand over at most this many bytes of the response envelope, cut before decoding; the " +
          "remainder is reported as truncated. The envelope is read whole either way, so this " +
          "bounds what you are handed rather than what the call reads.",
      ),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    exchange_id: exchangeIdSchema,
    status: z.number().int(),
    /** `success` | `fault` | `transport_error` */
    outcome: z.enum(["success", "fault", "transport_error"]),
    /**
     * The fault the envelope carried, when it carried one.
     *
     * Read from the whole envelope rather than from the `body.text` prefix, so a
     * fault past the cut is still reported as the call's outcome — however few
     * bytes `max_body_bytes` handed over — and a fault string can name text the
     * prefix does not reach.
     */
    fault: z
      .object({
        code: z.string().optional(),
        subcode: z.string().optional(),
        reason: z.string().optional(),
        detail: z.string().optional(),
      })
      .optional(),
    body: z.object({
      /** The envelope's length in bytes as received, whatever `max_body_bytes` says. */
      bytes: z.number().int(),
      /**
       * The response envelope decoded as UTF-8, cut to `max_body_bytes` of the
       * envelope's bytes before decoding when it is longer — 64 KiB unless the
       * caller asked for another cap. The cut is on bytes, so the text can end on
       * half a character; `text_lossy` says when it does.
       */
      text: z.string().optional(),
      /**
       * The bytes `text` was decoded from, base64-encoded, present whenever that
       * decode is lossy. Read it for the envelope's bytes and `text` for the words;
       * see the `uvp_http_request` output.
       */
      base64: z.string().optional(),
      /**
       * True when `text` is a prefix of the envelope: the cut `max_body_bytes`
       * made, or the transport's own read limit, or both. False means the text is
       * the whole envelope.
       */
      truncated: z.boolean(),
      /**
       * Why that decode is not the body's bytes, when it is not. Absent means
       * re-encoding the text returns what was decoded; see the `uvp_http_request`
       * output for the two values.
       */
      text_lossy: z.enum(["truncated", "invalid-utf8"]).optional(),
      /**
       * A digest over the whole envelope as received — not over the prefix `text`
       * shows — so it names the response rather than the part of it a cap let
       * through: raising `max_body_bytes` leaves this and `bytes` unchanged, and
       * two calls that asked for different amounts of the same envelope agree on
       * both. Compare it against a re-encoding of `text` only when `truncated` is
       * false.
       */
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
    /**
     * The most recorded body bytes this session holds in total.
     *
     * `max_body_bytes` bounds one exchange and says nothing about how many of
     * them accumulate, so without this a long capture is a process holding
     * gigabytes it never reports. Past the budget the oldest exchanges are
     * dropped and counted, and a read reports the count.
     */
    max_retained_bytes: z.number().int().min(1).optional(),
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
    "response payloads. Reports how many exchanges were held back by the read limit, how many the " +
    "session's own retention caps dropped, and how many bodies the recording limit cut short — so " +
    "an empty-looking or short result is never confused with traffic that was not there.",
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
    /** Every exchange this session recorded, in the page, held back, or dropped. */
    total_recorded: z.number().int(),
    /** Held back by this read's `limit`. */
    withheld_by_limit: z.number().int(),
    /** Dropped by the session's retention caps, so no longer readable at all. */
    withheld_by_retention: z.number().int(),
    /**
     * True when `since_id` is not an exchange this session still holds — it was
     * dropped by the retention caps, or never belonged to this capture. The page
     * then starts at the oldest exchange retained rather than at that id.
     */
    since_id_unknown: z.boolean(),
    /** The per-direction recording limit this session was started with. */
    body_limit_bytes: z.number().int(),
    /** The budget for all recorded bodies this session holds. */
    retained_limit_bytes: z.number().int(),
    /** The recorded body bytes actually held, either direction. */
    retained_bytes: z.number().int(),
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
 * Replaying a capture as a regression suite.
 *
 * The capture records what a client sent and what came back; this sends the same
 * requests again — to the service that just restarted, the one built from the
 * branch — and reports what still answers the same. There is no test file to
 * write, because the traffic already exists.
 *
 * Two decisions are visible in the schema and worth stating here, because a
 * caller reading `matched: 3` is relying on both:
 *
 * - **A method that writes is not sent.** Only `GET`, `HEAD`, and `OPTIONS` are
 *   replayed; a recorded `POST` is counted, named in `skipped_methods`, and left
 *   alone, because replaying it would write a second time and nothing here knows
 *   whether the endpoint is idempotent. That is also why `mutatesTarget` is
 *   false: it is not a hope about the target, it is the absence of any request
 *   that could change it.
 * - **A comparison with no ground is not a pass.** `outcome: "unknown"` means
 *   nothing was comparable at all, and `compared` says per exchange which fields
 *   were actually put side by side — so a status-only match is legible rather
 *   than indistinguishable from a full one.
 */
export const captureReplayContract = defineTool({
  name: "uvp_capture_replay",
  title: "Replay a capture",
  description:
    "Send a capture session's recorded exchanges again, to the origin it was captured from or to " +
    "another one, and report which answers are unchanged. Response bodies are compared by digest " +
    "and never returned, so the result carries no content from the target. Only methods that are " +
    "defined as safe are replayed; a recorded POST is reported as skipped rather than sent twice. " +
    "A replay that could compare nothing reports `unknown`, not success.",
  kind: "web",
  inputSchema: z.object({
    capture_id: captureIdSchema.optional().describe("Defaults to the most recent session."),
    since_id: exchangeIdSchema
      .optional()
      .describe("Replay only exchanges recorded after this one."),
    target: z
      .string()
      .optional()
      .describe(
        "Origin to replay against, such as http://127.0.0.1:8080. Defaults to the session's own " +
          "upstream. Each recorded exchange keeps its own path and query; a target carrying a path " +
          "is refused rather than resolved.",
      ),
    headers: headerMapSchema
      .default({})
      .describe(
        "Added to every replayed request, overriding a recorded header of that name — how a caller " +
          "asks a slightly different question of the same traffic.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(200)
      .describe(
        "Replay at most this many exchanges, oldest first, so a larger limit is a superset.",
      ),
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .default(30_000)
      .describe("Deadline for each replayed exchange."),
    verify_tls: z.boolean().default(true),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    capture_id: captureIdSchema,
    running: z.boolean(),
    /** The origin every exchange was replayed against. */
    target: z.string(),
    /** Exchanges the replay actually sent, which excludes the skipped ones. */
    replayed: z.number().int(),
    matched: z.number().int(),
    differed: z.number().int(),
    skipped: z.number().int(),
    not_comparable: z.number().int(),
    /** The distinct methods that were not sent, so a count is never a puzzle. */
    skipped_methods: z.array(z.string()),
    /**
     * `verified` when every replayed exchange answered as recorded, `failed`
     * when one answered differently, `partial` when something was left out,
     * and `unknown` when nothing was comparable at all.
     */
    outcome: z.enum(["verified", "failed", "partial", "unknown"]),
    exchanges: z.array(
      z.object({
        exchange_id: exchangeIdSchema,
        method: z.string(),
        /** Where the exchange was recorded from, which is the upstream at capture time. */
        url: z.string(),
        /** Where this replay sent it. Equal to `url` unless a target was given. */
        replayed_url: z.string(),
        outcome: z.enum(["matched", "differs", "skipped", "not_comparable"]),
        /** Why it was not sent, or why part of the comparison was left out. */
        reason: z.string().optional(),
        /** Which recorded facts were put side by side. */
        compared: z.array(z.enum(["status", "body"])),
        recorded_status: z.number().int().optional(),
        observed_status: z.number().int().optional(),
        /**
         * Digest of the recorded body, present only when that body is whole.
         * A body the session's recording limit cut is a prefix, and a digest of
         * a prefix compared with a digest of a whole body is the comparison this
         * field would otherwise invite.
         */
        recorded_body_digest: z.string().optional(),
        /** The same for the replayed body, when the call completed and it is whole. */
        observed_body_digest: z.string().optional(),
        /** Why the replayed call did not complete. The record is still reported. */
        error: z.string().optional(),
      }),
    ),
    /** Every exchange this session recorded, in the window, held back, or dropped. */
    total_recorded: z.number().int(),
    /** Held back by this replay's `limit`. */
    withheld_by_limit: z.number().int(),
    /** Dropped by the session's retention caps, so no longer replayable. */
    withheld_by_retention: z.number().int(),
    /** True when `since_id` is not an exchange this session still holds. */
    since_id_unknown: z.boolean(),
    /** The per-direction recording limit this session was started with. */
    body_limit_bytes: z.number().int(),
  }),
  effects: {
    // The session store is process state, read here exactly as
    // `uvp_capture_read` reads it; nothing is written.
    readsFilesystem: true,
    writesFilesystem: false,
    // It contacts a host: the origin being replayed against, which is the
    // session's upstream unless the caller names another one.
    network: true,
    spawnsProcess: false,
    // Not a hope that the endpoint is safe on a GET — the absence of any request
    // that could change it. `REPLAYABLE_METHODS` is what this declaration means.
    mutatesTarget: false,
  },
  examples: [
    {
      description: "Replay the last capture against the origin it came from",
      input: {},
    },
    {
      description: "Replay against a restarted service on another port",
      input: { target: "http://127.0.0.1:9090", limit: 500 },
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
    "any traffic. Returns one row per assertion, in the order asked, with the verdict it came to " +
    "and the observed value behind it, so a failure shows what was actually there rather than " +
    "only that it differed. An assertion the engine cannot carry out — a header the client never " +
    "read, a body that was never recorded, a pattern that does not compile, an expectation that " +
    "is not a pattern — comes back `undetermined` with the reason in its message: neither a pass " +
    "nor a failure, and counted as neither.",
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
    /**
     * The three counts and the rows they count.
     *
     * `satisfied + unmet + undetermined` is `results.length`, always: every
     * assertion asked appears exactly once, so a caller does not have to notice
     * an absent check to know one did not run. The vocabulary is `domain`'s
     * `VerdictStatus`, the one `uvp_doctor` reports feature availability with,
     * because a row here and a feature verdict there answer the same question
     * and must not spell their third state two ways.
     */
    satisfied: z.number().int(),
    unmet: z.number().int(),
    undetermined: z.number().int(),
    results: z.array(
      z.object({
        kind: z.string(),
        target: z.string().optional(),
        status: verdictStatusSchema,
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
