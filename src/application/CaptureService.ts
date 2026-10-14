import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";

import { UvpFailure } from "../domain/errors.js";
import { newId } from "../domain/identity.js";
import type { ExchangeRecord, SessionStore } from "./sessionStore.js";
import { performRequest } from "./httpClient.js";
import type { EvidenceRecorder } from "./evidenceHelpers.js";
import { coverageComplete, coveragePartial, endpointSource, record } from "./evidenceHelpers.js";

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
}

export interface CaptureStartResult {
  readonly capture_id: string;
  readonly listen_port: number;
  readonly proxy_url: string;
  readonly upstream?: string;
  readonly started_at: string;
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

/** Body bytes from an incoming request, bounded so a large upload cannot be buffered whole. */
const readRequestBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const limit = 8 * 1024 * 1024;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.byteLength;
    if (bytes <= limit) chunks.push(buffer);
  }
  return Buffer.concat(chunks);
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
    const exchanges: ExchangeRecord[] = [];
    let notRecorded = 0;
    let autoStop: NodeJS.Timeout | undefined;

    const server: Server = createServer((request, response) => {
      void this.#forward(request, response, {
        upstream,
        filter: input.filter,
        captureId,
        exchanges,
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
        reject(
          new UvpFailure({
            code: error.code === "EADDRINUSE" ? "service_unavailable" : "capture_unavailable",
            message:
              error.code === "EADDRINUSE"
                ? `Port ${String(input.listen_port)} is already in use.`
                : `The capture proxy could not listen: ${error.message}`,
            remediation: {
              action:
                error.code === "EADDRINUSE"
                  ? "Choose a free listen_port."
                  : "Check that this process may open a listening socket.",
            },
          }),
        );
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
      server,
      exchanges,
      stopped: false,
    });

    if (input.max_exchanges !== undefined || input.auto_stop_ms !== undefined) {
      autoStop = setInterval(() => {
        const reached =
          input.max_exchanges !== undefined && exchanges.length >= input.max_exchanges;
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
      observed: { filter: { ...input.filter } },
      coverage: coverageComplete("capture session started"),
      sources: [endpointSource(`http://127.0.0.1:${String(input.listen_port)}`)],
      limitations: [
        "The capture proxy speaks HTTP; a CONNECT tunnel is not intercepted and its contents are not recorded.",
      ],
    });

    return {
      capture_id: captureId,
      listen_port: input.listen_port,
      proxy_url: `http://127.0.0.1:${String(input.listen_port)}`,
      ...(input.upstream === undefined ? {} : { upstream: input.upstream }),
      started_at: startedAt,
    };
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
      duration_ms: number;
      request_body?: string;
      response_body?: string;
      error?: string;
    }[];
    total_recorded: number;
    withheld_by_limit: number;
  }> {
    const session =
      input.capture_id === undefined
        ? this.store.latestCapture()
        : this.store.capture(input.capture_id);
    if (session === undefined) {
      throw new UvpFailure({
        code: "capture_unavailable",
        message:
          input.capture_id === undefined
            ? "No capture session has been started in this session."
            : `No capture session ${input.capture_id} exists in this session.`,
        remediation: {
          action:
            "Start one with uvp_capture_start. Capture sessions do not survive the end of a session.",
        },
      });
    }

    const ordered = session.exchanges;
    const start =
      input.since_id === undefined
        ? 0
        : Math.max(0, ordered.findIndex((entry) => entry.exchangeId === input.since_id) + 1);
    const slice = ordered.slice(start, start + input.limit);

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
        duration_ms: entry.durationMs,
        ...(input.include_payloads && entry.requestBody !== undefined
          ? { request_body: entry.requestBody.toString("utf8").slice(0, 64 * 1024) }
          : {}),
        ...(input.include_payloads && entry.responseBody !== undefined
          ? { response_body: entry.responseBody.toString("utf8").slice(0, 64 * 1024) }
          : {}),
        ...(entry.error === undefined ? {} : { error: entry.error }),
      })),
      total_recorded: ordered.length,
      withheld_by_limit: Math.max(0, ordered.length - start - slice.length),
    };
  }

  async #forward(
    request: IncomingMessage,
    response: ServerResponse,
    context: {
      readonly upstream: URL;
      readonly filter: CaptureFilter;
      readonly captureId: string;
      readonly exchanges: ExchangeRecord[];
      readonly recorder: EvidenceRecorder;
      readonly onSkipped: () => void;
    },
  ): Promise<void> {
    const { upstream, filter, captureId, exchanges, recorder, onSkipped } = context;
    const incoming = new URL(request.url ?? "/", upstream.origin);
    const target = new URL(`${incoming.pathname}${incoming.search}`, upstream);
    const requestBody = await readRequestBody(request);
    const started = Date.now();

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
      requestBody,
      responseBody: exchange?.body,
      durationMs: Date.now() - started,
      truncated: exchange?.bodyTruncated ?? false,
      error,
      captureId,
    };
    exchanges.push(record_);
    this.store.addExchange(record_);

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
