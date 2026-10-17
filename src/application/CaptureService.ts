import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";

import { UvpFailure } from "../domain/errors.js";
import { newId } from "../domain/identity.js";
import {
  DEFAULT_RETAINED_BYTES,
  MAX_CAPTURE_EXCHANGES,
  createCaptureRetention,
  retainCaptureExchange,
} from "./sessionStore.js";
import type {
  CaptureRetention,
  CaptureSession,
  ExchangeRecord,
  SessionStore,
} from "./sessionStore.js";
import { performRequest } from "./httpClient.js";
import type { EvidenceRecorder } from "./evidenceHelpers.js";
import { coverageComplete, coveragePartial, endpointSource, record } from "./evidenceHelpers.js";
import { replayCapture } from "./captureReplay.js";
import type { ReplayRequest, ReplayResult } from "./captureReplay.js";

/**
 * Traffic capture.
 *
 * A capture session is a reverse proxy with a notebook: it accepts a request,
 * forwards it, relays the response, and writes down what passed through. The
 * point is to observe traffic from a client that cannot be modified — a browser,
 * a device, an SDK — so the record has to be the bytes that actually crossed the
 * wire, not a reconstruction from what the client said it would send.
 *
 * Two design choices carry the honesty of the result:
 *
 *   - **Nothing is filtered out silently.** A request the filter does not match
 *     is forwarded and *not* recorded, and the count of those is kept, because a
 *     capture that reports "3 exchanges" when 40 went past is worse than no
 *     capture at all.
 *   - **A session outlives the call that started it.** `uvp_capture_start`
 *     returns while the proxy keeps listening, so the caller can point a client
 *     at it. Session ownership means the socket is closed when the uvp session
 *     ends, not when the process does.
 */

export interface CaptureFilter {
  readonly hosts: readonly string[];
  readonly methods: readonly string[];
  readonly path_prefix?: string | undefined;
}

export interface CaptureStartInput {
  readonly listen_port: number;
  readonly upstream: string | undefined;
  readonly filter: CaptureFilter;
  readonly max_exchanges: number | undefined;
  readonly auto_stop_ms: number | undefined;
  /** The most bytes kept per direction per exchange. Reported by every read. */
  readonly max_body_bytes: number;
  /** The most recorded body bytes this session holds in total. */
  readonly max_retained_bytes: number | undefined;
}

/**
 * The most of an incoming body the proxy will hold in order to forward it.
 *
 * Not the recording limit, and deliberately larger: a request is only
 * forwardable whole, so this is the point past which the proxy cannot relay what
 * it was given. It used to drop the remainder and send the truncated body
 * upstream, which answered a caller's upload with a corrupt one and recorded the
 * result as the bytes that crossed the wire. A request past it is refused with
 * `413` and named, because a proxy that quietly rewrites a payload is worse than
 * one that says it will not carry it.
 */
const FORWARD_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;

export interface CaptureStartResult {
  readonly capture_id: string;
  readonly listen_port: number;
  readonly proxy_url: string;
  readonly upstream?: string;
  readonly started_at: string;
  /** The recording limit in force, so a caller need not read it off the input. */
  readonly max_body_bytes: number;
}

const matches = (filter: CaptureFilter, request: IncomingMessage, url: URL): boolean => {
  if (filter.hosts.length > 0 && !filter.hosts.includes(url.hostname)) return false;
  if (filter.methods.length > 0) {
    const method = (request.method ?? "GET").toUpperCase();
    if (!filter.methods.some((entry) => entry.toUpperCase() === method)) return false;
  }
  if (filter.path_prefix !== undefined && !url.pathname.startsWith(filter.path_prefix))
    return false;
  return true;
};

/**
 * Body bytes from an incoming request, up to the forwarding limit.
 *
 * `exceeded` is returned rather than inferred: the buffer stops growing at the
 * limit, so the only way to know the request was longer is for this function to
 * say so. Dropping the remainder and returning what fits is how a truncated
 * upload was forwarded as if it were complete.
 */
const readRequestBody = async (
  request: IncomingMessage,
): Promise<{ readonly body: Buffer; readonly exceeded: boolean }> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let exceeded = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const before = bytes;
    bytes += buffer.byteLength;
    if (bytes <= FORWARD_BUFFER_LIMIT_BYTES) chunks.push(buffer);
    else if (before < FORWARD_BUFFER_LIMIT_BYTES) {
      // The chunk that crossed the limit: keep the part of it that fits, so the
      // refusal can name how much was offered rather than only that it was long.
      chunks.push(buffer.subarray(0, FORWARD_BUFFER_LIMIT_BYTES - before));
      exceeded = true;
    } else exceeded = true;
  }
  return { body: Buffer.concat(chunks), exceeded };
};

/** The bytes kept for a record, and whether the caller's limit cut them short. */
const capped = (
  body: Buffer | undefined,
  maxBytes: number,
): { readonly body: Buffer | undefined; readonly truncated: boolean } =>
  body === undefined || body.byteLength <= maxBytes
    ? { body, truncated: false }
    : { body: body.subarray(0, maxBytes), truncated: true };

/**
 * The failure a capture proxy reports when it cannot listen.
 *
 * `EADDRINUSE` is the one bind failure with an obvious retry: another process may
 * free the port, so it stays `service_unavailable`, which is retryable. Every
 * other bind failure — `EACCES`, `EADDRNOTAVAIL`, `EAFNOSUPPORT` — is a permission
 * or configuration fact a retry does not change, so it is `capture_listen_failed`,
 * category `execution_failure` and not retryable. The remedy is the caller's, not
 * a loop's. [#49](https://github.com/Antruly/uvp/issues/49) split the code from the
 * session lookup, whose own failure is `capture_not_found`.
 *
 * This function is the bind half's only site, and it is exported so the mapping
 * can be tested without binding a socket.
 */
export const captureListenFailure = (error: NodeJS.ErrnoException, port: number): UvpFailure => {
  if (error.code === "EADDRINUSE") {
    return new UvpFailure({
      code: "service_unavailable",
      message: `Port ${String(port)} is already in use.`,
      remediation: { action: "Choose a free listen_port." },
    });
  }
  return new UvpFailure({
    code: "capture_listen_failed",
    message: `The capture proxy could not listen: ${error.message}`,
    remediation: { action: "Check that this process may open a listening socket." },
  });
};

export class CaptureService {
  constructor(
    private readonly store: SessionStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(input: CaptureStartInput, recorder: EvidenceRecorder): Promise<CaptureStartResult> {
    if (input.upstream === undefined) {
      // A forward proxy needs absolute-form request targets and CONNECT, which
      // this deliberately does not implement. Saying so now is better than
      // answering 502 to every request after the caller has wired a client up.
      throw new UvpFailure({
        code: "invalid_request",
        message: "A capture session needs an upstream origin.",
        remediation: {
          action:
            "Pass upstream, for example http://127.0.0.1:8080, and point the client at this capture's " +
            "proxy_url. Forward-proxy (absolute-form and CONNECT) capture is not implemented.",
        },
      });
    }

    let upstream: URL;
    try {
      upstream = new URL(input.upstream);
    } catch {
      throw new UvpFailure({
        code: "invalid_request",
        message: `"${input.upstream}" is not an absolute URL.`,
        remediation: { action: "Pass upstream as an absolute URL, such as http://127.0.0.1:8080." },
      });
    }

    const captureId = newId("capture");
    const startedAt = this.now().toISOString();
    const maxRetainedBytes = input.max_retained_bytes ?? DEFAULT_RETAINED_BYTES;
    // Built before the server, because the request handler needs it and the
    // session that reports it does not exist until the listener is bound.
    const retention = createCaptureRetention(maxRetainedBytes);
    let notRecorded = 0;
    let autoStop: NodeJS.Timeout | undefined;

    const server: Server = createServer((request, response) => {
      void this.#forward(request, response, {
        upstream,
        filter: input.filter,
        captureId,
        retention,
        maxBodyBytes: input.max_body_bytes,
        recorder,
        onSkipped: () => {
          notRecorded += 1;
        },
      }).catch(() => {
        if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
        response.end("uvp: the capture proxy failed to forward this request\n");
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        reject(captureListenFailure(error, input.listen_port));
      });
      server.listen(input.listen_port, "127.0.0.1", () => {
        resolve();
      });
    });

    const session = this.store.addCapture({
      captureId,
      listenPort: input.listen_port,
      upstream: input.upstream,
      startedAt,
      maxBodyBytes: input.max_body_bytes,
      maxRetainedBytes,
      server,
      retention,
      stopped: false,
    });

    if (input.max_exchanges !== undefined || input.auto_stop_ms !== undefined) {
      autoStop = setInterval(() => {
        const reached =
          input.max_exchanges !== undefined && retention.recorded >= input.max_exchanges;
        const expired =
          input.auto_stop_ms !== undefined &&
          Date.now() - Date.parse(startedAt) >= input.auto_stop_ms;
        if (!reached && !expired) return;
        if (autoStop !== undefined) clearInterval(autoStop);
        session.stopped = true;
        server.close();
      }, 250);
      autoStop.unref?.();
    }

    record(recorder, {
      kind: "capture",
      subject: { capture_id: captureId, listen_port: input.listen_port, upstream: input.upstream },
      observed: {
        filter: { ...input.filter },
        max_body_bytes: input.max_body_bytes,
        max_retained_bytes: maxRetainedBytes,
      },
      coverage: coverageComplete("capture session started"),
      sources: [endpointSource(`http://127.0.0.1:${String(input.listen_port)}`)],
      limitations: [
        "The capture proxy speaks HTTP; a CONNECT tunnel is not intercepted and its contents are not recorded.",
        `Bodies are recorded to ${String(input.max_body_bytes)} bytes per direction, and forwarded whole regardless.`,
        // The cap that ends a session's usefulness, stated at the start rather
        // than discovered in a read: past it, the oldest exchanges are gone.
        `This session holds the most recent ${String(MAX_CAPTURE_EXCHANGES)} exchanges, and at most ` +
          `${String(maxRetainedBytes)} bytes of recorded bodies across them. Older ones are dropped ` +
          "and counted, not silently overwritten.",
      ],
    });

    return {
      capture_id: captureId,
      listen_port: input.listen_port,
      proxy_url: `http://127.0.0.1:${String(input.listen_port)}`,
      ...(input.upstream === undefined ? {} : { upstream: input.upstream }),
      started_at: startedAt,
      max_body_bytes: input.max_body_bytes,
    };
  }

  /**
   * The session a caller means, or a failure naming the one that was not there.
   *
   * One home for the lookup and its wording: `read` and `replay` mean a session
   * the same way — the id, or the most recent one — and a caller who mistyped an
   * id should not have to work out which of the two tools they mistyped it into.
   */
  #session(captureId: string | undefined): CaptureSession {
    const session =
      captureId === undefined ? this.store.latestCapture() : this.store.capture(captureId);
    if (session !== undefined) return session;
    throw new UvpFailure({
      code: "capture_not_found",
      message:
        captureId === undefined
          ? "No capture session has been started in this session."
          : `No capture session ${captureId} exists in this session.`,
      remediation: {
        action:
          "Start one with uvp_capture_start. Capture sessions do not survive the end of a session.",
      },
    });
  }

  /**
   * The exchanges a caller means, in the order the call will handle them.
   *
   * A cursor this session no longer holds is reported rather than treated as
   * "start at the beginning": an id that aged out of the retention window and an
   * id that never existed both land here, and answering either one with the
   * oldest retained exchange is a guess a caller would read as continuity.
   *
   * The page is a prefix of the window, oldest first, so raising the limit adds
   * exchanges rather than replacing them — which is what makes a replay with a
   * larger limit a superset of the run before it. It is a prefix of *this*
   * window, not of the capture: a session still running drops its oldest
   * exchanges to stay inside its caps, and that drop is counted separately.
   */
  #select(
    session: CaptureSession,
    sinceId: string | undefined,
    limit: number,
  ): {
    readonly ordered: readonly ExchangeRecord[];
    readonly start: number;
    readonly slice: readonly ExchangeRecord[];
    readonly sinceIdUnknown: boolean;
  } {
    const ordered = session.retention.exchanges;
    const cursor = sinceId === undefined ? -1 : ordered.findIndex((e) => e.exchangeId === sinceId);
    const sinceIdUnknown = sinceId !== undefined && cursor === -1;
    const start = cursor < 0 ? 0 : cursor + 1;
    return { ordered, start, slice: ordered.slice(start, start + limit), sinceIdUnknown };
  }

  async read(input: {
    readonly capture_id: string | undefined;
    readonly since_id: string | undefined;
    readonly limit: number;
    readonly include_payloads: boolean;
    readonly stop: boolean;
  }): Promise<{
    capture_id: string;
    running: boolean;
    exchanges: {
      exchange_id: string;
      at: string;
      method: string;
      url: string;
      status?: number;
      request_bytes: number;
      response_bytes: number;
      request_body_truncated: boolean;
      response_body_truncated: boolean;
      duration_ms: number;
      request_body?: string;
      response_body?: string;
      error?: string;
    }[];
    total_recorded: number;
    withheld_by_limit: number;
    withheld_by_retention: number;
    since_id_unknown: boolean;
    body_limit_bytes: number;
    retained_limit_bytes: number;
    retained_bytes: number;
    bodies_truncated: number;
  }> {
    const session = this.#session(input.capture_id);

    const { retention } = session;
    const { ordered, start, slice, sinceIdUnknown } = this.#select(
      session,
      input.since_id,
      input.limit,
    );

    if (input.stop && !session.stopped) {
      session.stopped = true;
      session.server.close();
    }

    return {
      capture_id: session.captureId,
      running: !session.stopped,
      exchanges: slice.map((entry) => ({
        exchange_id: entry.exchangeId,
        at: entry.at,
        method: entry.method,
        url: entry.url,
        ...(entry.status === undefined ? {} : { status: entry.status }),
        request_bytes: entry.requestBody?.byteLength ?? 0,
        response_bytes: entry.responseBody?.byteLength ?? 0,
        request_body_truncated: entry.requestBodyTruncated,
        response_body_truncated: entry.responseBodyTruncated,
        duration_ms: entry.durationMs,
        // No second cap here. Payloads used to be cut again at 64 KiB on the way
        // out, in characters rather than bytes, which both hid the session's own
        // limit from the caller and could split a multi-byte character in half.
        ...(input.include_payloads && entry.requestBody !== undefined
          ? { request_body: entry.requestBody.toString("utf8") }
          : {}),
        ...(input.include_payloads && entry.responseBody !== undefined
          ? { response_body: entry.responseBody.toString("utf8") }
          : {}),
        ...(entry.error === undefined ? {} : { error: entry.error }),
      })),
      // Every recorded exchange is either in this page, counted in
      // `withheld_by_limit`, or gone from the session — so the three numbers add
      // up to the total, and a caller can check that rather than trust it.
      total_recorded: retention.recorded,
      withheld_by_limit: Math.max(0, ordered.length - start - slice.length),
      withheld_by_retention: retention.withheld,
      since_id_unknown: sinceIdUnknown,
      // The limit that produced the flags above, so a caller reading a body can
      // tell how much of it they are looking at without consulting start-up.
      body_limit_bytes: session.maxBodyBytes,
      retained_limit_bytes: session.maxRetainedBytes,
      retained_bytes: retention.bytes,
      bodies_truncated: slice.filter(
        (entry) => entry.requestBodyTruncated || entry.responseBodyTruncated,
      ).length,
    };
  }

  /**
   * Replay this session's captured exchanges, and report what still answers the
   * same.
   *
   * The session and the window are this class's to resolve — `#session` and
   * `#select` answer the same cursor and limit for `uvp_capture_read`, and a
   * second reading of them would be a second definition of what a cursor means.
   * What the record *means* once it is a list of exchanges belongs to
   * `captureReplay.ts`, which is where the sending and the comparing live.
   */
  async replay(input: ReplayRequest, recorder: EvidenceRecorder): Promise<ReplayResult> {
    const session = this.#session(input.capture_id);
    const { start, slice, sinceIdUnknown } = this.#select(session, input.since_id, input.limit);
    return await replayCapture(
      {
        session,
        exchanges: slice,
        withheldByLimit: Math.max(0, session.retention.exchanges.length - start - slice.length),
        sinceIdUnknown,
      },
      input,
      recorder,
    );
  }

  async #forward(
    request: IncomingMessage,
    response: ServerResponse,
    context: {
      readonly upstream: URL;
      readonly filter: CaptureFilter;
      readonly captureId: string;
      readonly retention: CaptureRetention;
      readonly maxBodyBytes: number;
      readonly recorder: EvidenceRecorder;
      readonly onSkipped: () => void;
    },
  ): Promise<void> {
    const { upstream, filter, captureId, retention, maxBodyBytes, recorder, onSkipped } = context;
    const incoming = new URL(request.url ?? "/", upstream.origin);
    const target = new URL(`${incoming.pathname}${incoming.search}`, upstream);
    const { body: requestBody, exceeded } = await readRequestBody(request);
    const started = Date.now();

    if (exceeded) {
      // Refused rather than truncated. The client is told, and the capture shows
      // it, so neither side is left believing a payload crossed intact.
      const reason =
        `the request body exceeded the ${String(FORWARD_BUFFER_LIMIT_BYTES)} bytes this proxy ` +
        `buffers in order to forward it whole`;
      retainCaptureExchange(
        retention,
        this.store.addExchange({
          exchangeId: newId("exchange"),
          at: this.now().toISOString(),
          method: request.method ?? "GET",
          url: target.toString(),
          status: undefined,
          statusText: undefined,
          httpVersion: undefined,
          requestHeaders: request.headers as Record<string, string>,
          responseHeaders: {},
          // No response was read: this branch is the 413 for a request whose body
          // was over the session's limit, recorded so the capture shows what was
          // refused. There is nothing to be narrower than "all of it".
          responseHeadersObserved: undefined,
          requestBody: capped(requestBody, maxBodyBytes).body,
          responseBody: undefined,
          requestBodyTruncated: true,
          responseBodyTruncated: false,
          durationMs: 0,
          error: reason,
          captureId,
        }),
      );
      response.writeHead(413, { "content-type": "text/plain" });
      response.end(`uvp: ${reason}\n`);
      return;
    }

    if (!matches(filter, request, target)) {
      // Forwarded, not recorded — and counted, so the difference is visible.
      onSkipped();
      const passthrough = await performRequest({
        url: target.toString(),
        method: request.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries(request.headers).flatMap(([name, value]) =>
            typeof value === "string" ? [[name, value]] : [],
          ),
        ),
        body: requestBody.byteLength === 0 ? undefined : requestBody,
        httpVersion: "auto",
        followRedirects: false,
        maxRedirects: 0,
        verifyTls: true,
        timeoutMs: 30_000,
      }).catch(() => undefined);
      if (passthrough === undefined) {
        response.writeHead(502);
        response.end();
        return;
      }
      response.writeHead(passthrough.status, { ...passthrough.headers });
      response.end(passthrough.body);
      return;
    }

    const headers: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(request.headers).flatMap(([name, value]) =>
          typeof value === "string" ? [[name, value]] : [],
        ),
      ),
      host: upstream.host,
    };

    let error: string | undefined;
    const exchange = await performRequest({
      url: target.toString(),
      method: request.method ?? "GET",
      headers,
      body: requestBody.byteLength === 0 ? undefined : requestBody,
      httpVersion: "auto",
      followRedirects: false,
      maxRedirects: 0,
      verifyTls: true,
      timeoutMs: 60_000,
    }).catch((cause: unknown) => {
      error = cause instanceof Error ? cause.message : String(cause);
      return undefined;
    });

    const keptRequest = capped(requestBody, maxBodyBytes);
    const keptResponse = capped(exchange?.body, maxBodyBytes);
    const record_: ExchangeRecord = {
      exchangeId: newId("exchange"),
      at: this.now().toISOString(),
      method: request.method ?? "GET",
      url: target.toString(),
      status: exchange?.status,
      statusText: exchange?.statusText,
      httpVersion: exchange?.httpVersion,
      requestHeaders: headers,
      responseHeaders: exchange?.headers ?? {},
      // The capture proxy reads a whole response from Node, so every header the
      // peer sent is here; there is nothing this record did not look at.
      responseHeadersObserved: undefined,
      requestBody: keptRequest.body,
      responseBody: keptResponse.body,
      // A response is cut short by whichever limit bit first: this session's, or
      // the transport's own read limit, which reported the same thing one layer
      // down and must not be lost when the recording limit is raised past it.
      requestBodyTruncated: keptRequest.truncated,
      responseBodyTruncated: keptResponse.truncated || (exchange?.bodyTruncated ?? false),
      durationMs: Date.now() - started,
      error,
      captureId,
    };
    retainCaptureExchange(retention, this.store.addExchange(record_));

    if (error !== undefined) {
      record(recorder, {
        kind: "capture",
        subject: { url: target.toString(), method: record_.method },
        observed: { error },
        coverage: coveragePartial(
          "captured exchange",
          "the upstream request did not complete",
          0,
          1,
        ),
        sources: [endpointSource(target.toString())],
      });
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(`uvp: upstream error: ${error}\n`);
      return;
    }
    if (exchange === undefined) return;

    response.writeHead(exchange.status, { ...exchange.headers });
    response.end(exchange.body);
  }
}
