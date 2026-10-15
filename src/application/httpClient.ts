import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { connect as http2Connect } from "node:http2";
import type { ClientHttp2Session } from "node:http2";
import { Buffer } from "node:buffer";

/**
 * A low-level HTTP client that reports what actually happened.
 *
 * This deliberately does not use `fetch`. Three things a debugging tool must
 * have are not reachable through it: the negotiated protocol version, the TLS
 * peer certificate details, and a per-phase timing breakdown. Every one of
 * those is a fact a caller may need, and a wrapper that hides them would be
 * hiding the answer.
 */

export interface HttpRequestSpec {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer | undefined;
  readonly httpVersion: "auto" | "1.1" | "2" | "3";
  readonly followRedirects: boolean;
  readonly maxRedirects: number;
  readonly verifyTls: boolean;
  /**
   * How long the whole call may take — the redirect chain included, since the
   * caller asked one question and every hop is part of answering it.
   */
  readonly timeoutMs: number;
}

/**
 * What a transport failure was, decided where it was seen.
 *
 * Node reports a socket failure as an errno on an `Error`; this module reports
 * its own deadline as a plain one. Both describe the exchange, and both are
 * known to the code that saw them fail — so the kind is attached there and read
 * by callers, rather than recovered downstream by matching text.
 *
 * It is not only wording. `auto` retries over HTTP/2 when the peer did not speak
 * HTTP/1.1, and must not retry anything else; and `uvp_http_request` reports a
 * deadline as `timeout` and a refused connection as `endpoint_unreachable`. Three
 * separate regexes over the message once answered the same question three ways,
 * and every one of them changed meaning the moment a message did.
 */
export type TransportFailureKind = "timeout" | "unreachable" | "protocol" | "tls";

export class TransportFailure extends Error {
  readonly kind: TransportFailureKind;

  constructor(kind: TransportFailureKind, message: string) {
    super(message);
    this.name = "TransportFailure";
    this.kind = kind;
  }
}

/** Errnos that mean the peer was never reached, or left mid-conversation. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EPROTO",
]);

/** Certificate failures, which are reported as themselves and not as a refusal. */
const TLS_CODES: ReadonlySet<string> = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

/**
 * The kind of a failure Node raised, from the errno it attached.
 *
 * Anything unrecognised is `unreachable` — the bucket that says "the exchange
 * did not complete, and it was not the protocol or the clock". Guessing a more
 * specific kind from a code this module does not know would be inventing a
 * classification, which is the error the whole evidence model exists to avoid.
 */
const kindOfNodeError = (error: NodeJS.ErrnoException): TransportFailureKind => {
  const code = error.code ?? "";
  if (code === "ETIMEDOUT") return "timeout";
  if (TLS_CODES.has(code) || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL")) return "tls";
  // `HPE_*` is Node's HTTP parser refusing bytes; `ERR_HTTP2*` is the h2 stack
  // doing the same. Both mean the peer is speaking something else.
  if (code.startsWith("HPE_") || code.startsWith("ERR_HTTP2")) return "protocol";
  if (UNREACHABLE_CODES.has(code)) return "unreachable";
  return "unreachable";
};

/** The kind of anything a caller caught, including a value that is not an `Error`. */
export const transportFailureKind = (cause: unknown): TransportFailureKind => {
  if (cause instanceof TransportFailure) return cause.kind;
  if (cause instanceof Error) return kindOfNodeError(cause as NodeJS.ErrnoException);
  return "unreachable";
};

export interface HttpTiming {
  readonly dnsMs: number | undefined;
  readonly connectMs: number | undefined;
  readonly tlsMs: number | undefined;
  readonly ttfbMs: number | undefined;
  readonly totalMs: number;
}

export interface TlsInfo {
  readonly protocol: string | undefined;
  readonly cipher: string | undefined;
  readonly subject: string | undefined;
  readonly issuer: string | undefined;
  readonly validFrom: string | undefined;
  readonly validTo: string | undefined;
  readonly verified: boolean;
  readonly errors: readonly string[];
}

export interface HttpExchange {
  readonly url: string;
  readonly method: string;
  readonly status: number;
  readonly statusText: string;
  /** The version actually used, which is what the caller needs to know. */
  readonly httpVersion: string;
  readonly requestHttpVersion: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly bodyBytes: number;
  readonly bodyTruncated: boolean;
  readonly timing: HttpTiming;
  readonly tls: TlsInfo | undefined;
  readonly redirects: readonly { status: number; location: string }[];
}

const normaliseHeaders = (raw: NodeJS.Dict<string | string[]>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
};

const peerCertificateInfo = (socket: {
  getPeerCertificate?: (detailed: boolean) => unknown;
  getProtocol?: () => string | null;
  getCipher?: () => { name: string };
}): TlsInfo | undefined => {
  if (typeof socket.getPeerCertificate !== "function") return undefined;
  const certificate = socket.getPeerCertificate(true) as
    | {
        subject?: Record<string, string>;
        issuer?: Record<string, string>;
        valid_from?: string;
        valid_to?: string;
      }
    | undefined;
  const protocol = typeof socket.getProtocol === "function" ? socket.getProtocol() : null;
  const cipher = typeof socket.getCipher === "function" ? socket.getCipher() : undefined;
  if (certificate === undefined) return undefined;
  const describe = (name: Record<string, string> | undefined): string | undefined =>
    name === undefined ? undefined : (name["CN"] ?? name["O"] ?? Object.values(name)[0]);
  return {
    protocol: protocol ?? undefined,
    cipher: cipher?.name,
    subject: describe(certificate.subject),
    issuer: describe(certificate.issuer),
    validFrom: certificate.valid_from,
    validTo: certificate.valid_to,
    // Authorisation failure is recorded rather than thrown: the exchange still
    // happened and its bytes are still evidence.
    verified: false,
    errors: [],
  };
};

interface SingleShotResult {
  readonly status: number;
  readonly statusText: string;
  readonly httpVersion: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly bodyTruncated: boolean;
  readonly timing: HttpTiming;
  readonly tls: TlsInfo | undefined;
}

const performHttp1 = (spec: HttpRequestSpec, url: URL): Promise<SingleShotResult> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const secure = url.protocol === "https:";
    const requestFn = secure ? httpsRequest : httpRequest;
    const options: HttpsRequestOptions = {
      method: spec.method,
      hostname: url.hostname,
      port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
      path: `${url.pathname}${url.search}`,
      headers: {
        ...spec.headers,
        ...(spec.body === undefined ? {} : { "content-length": String(spec.body.byteLength) }),
      },
      ...(secure ? { rejectUnauthorized: spec.verifyTls } : {}),
    };

    let dnsAt: number | undefined;
    let connectAt: number | undefined;
    let tlsAt: number | undefined;
    let firstByteAt: number | undefined;
    let settled = false;

    // One deadline for the attempt, not an inactivity timer. A service that
    // trickles a byte every few seconds resets an inactivity timer forever, so
    // the caller's `timeout_ms` would never fire on the connection it was set
    // for. The body is buffered whole before this resolves, so there is no
    // streaming case that a total deadline would cut short.
    const timer = setTimeout(() => {
      req.destroy(
        new TransportFailure("timeout", `Request timed out after ${String(spec.timeoutMs)} ms`),
      );
    }, spec.timeoutMs);

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        error instanceof TransportFailure
          ? error
          : new TransportFailure(kindOfNodeError(error as NodeJS.ErrnoException), error.message),
      );
    };

    const req = requestFn(options, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      const limit = 8 * 1024 * 1024;
      res.on("data", (chunk: Buffer) => {
        firstByteAt ??= Date.now();
        bytes += chunk.byteLength;
        if (bytes <= limit) chunks.push(chunk);
        else truncated = true;
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const socket = res.socket as unknown as Parameters<typeof peerCertificateInfo>[0];
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "",
          httpVersion: res.httpVersion,
          headers: normaliseHeaders(res.headers),
          body: Buffer.concat(chunks),
          bodyTruncated: truncated,
          timing: {
            dnsMs: dnsAt === undefined ? undefined : dnsAt - started,
            connectMs: connectAt === undefined ? undefined : connectAt - (dnsAt ?? started),
            tlsMs: tlsAt === undefined ? undefined : tlsAt - (connectAt ?? started),
            ttfbMs: (firstByteAt ?? Date.now()) - started,
            totalMs: Date.now() - started,
          },
          tls: secure ? peerCertificateInfo(socket) : undefined,
        });
      });
      res.on("error", fail);
    });

    req.on("socket", (socket) => {
      socket.once("lookup", () => {
        dnsAt = Date.now();
      });
      socket.once("connect", () => {
        connectAt = Date.now();
      });
      socket.once("secureConnect", () => {
        tlsAt = Date.now();
      });
    });
    req.on("error", fail);
    if (spec.body !== undefined) req.write(spec.body);
    req.end();
  });

const performHttp2 = (spec: HttpRequestSpec, url: URL): Promise<SingleShotResult> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const secure = url.protocol === "https:";
    const authority = `${url.protocol}//${url.host}`;
    // Only meaningful over TLS, and only set when it is: passing it for a
    // cleartext h2c session would suggest a check that does not happen.
    const connectOptions = secure ? { rejectUnauthorized: spec.verifyTls } : {};
    const client: ClientHttp2Session = http2Connect(authority, connectOptions);
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.close();
      reject(
        error instanceof TransportFailure
          ? error
          : new TransportFailure(kindOfNodeError(error as NodeJS.ErrnoException), error.message),
      );
    };

    // Same rule as the HTTP/1.1 path: the deadline covers the attempt, so a
    // session that keeps the socket warm is still cut off when it expires.
    const timer = setTimeout(() => {
      fail(new TransportFailure("timeout", `Request timed out after ${String(spec.timeoutMs)} ms`));
    }, spec.timeoutMs);

    client.once("error", fail);

    const stream = client.request({
      ":method": spec.method,
      ":path": `${url.pathname}${url.search}`,
      ...(spec.headers["accept"] === undefined ? {} : { accept: spec.headers["accept"] }),
      ...(spec.headers["content-type"] === undefined
        ? {}
        : { "content-type": spec.headers["content-type"] }),
    });

    let firstByteAt: number | undefined;
    let status = 0;
    let headers: Record<string, string> = {};
    let responded = false;

    stream.on("response", (responseHeaders) => {
      responded = true;
      status = Number(responseHeaders[":status"] ?? 0);
      headers = {};
      for (const [key, value] of Object.entries(responseHeaders)) {
        if (key.startsWith(":")) continue;
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
      }
    });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const limit = 8 * 1024 * 1024;
    stream.on("data", (chunk: Buffer) => {
      firstByteAt ??= Date.now();
      bytes += chunk.byteLength;
      if (bytes <= limit) chunks.push(chunk);
      else truncated = true;
    });
    stream.on("error", fail);
    stream.on("end", () => {
      if (settled) return;
      // A stream that ends without a response header block never delivered an
      // answer; the peer took the connection and hung up. Resolving here would
      // report `status: 0` as something observed, and a caller comparing
      // statuses would read "no response" as "the service answered with
      // something unusual" — which is the one reading the bytes do not support.
      // HTTP/1.1 cannot reach this state, because it resolves from inside the
      // response callback; this is the h2 shape of the same rule.
      if (!responded) {
        fail(
          new TransportFailure(
            "unreachable",
            `${authority} closed the connection before sending a response.`,
          ),
        );
        return;
      }
      settled = true;
      const socket = client.socket as unknown as Parameters<typeof peerCertificateInfo>[0];
      client.close();
      resolve({
        status,
        statusText: "",
        httpVersion: "2.0",
        headers,
        body: Buffer.concat(chunks),
        bodyTruncated: truncated,
        timing: {
          dnsMs: undefined,
          connectMs: undefined,
          tlsMs: undefined,
          ttfbMs: (firstByteAt ?? Date.now()) - started,
          totalMs: Date.now() - started,
        },
        tls: secure ? peerCertificateInfo(socket) : undefined,
      });
    });

    if (spec.body !== undefined) stream.end(spec.body);
    else stream.end();
  });

/**
 * Perform one request, following redirects only when asked.
 *
 * Redirects are not followed by default. A debugging tool that silently
 * rewrites the request is hiding the exchange the user asked about; when
 * following is requested, every hop is reported.
 *
 * The deadline is the caller's, and it covers the call: every hop and every
 * protocol attempt draws on the same budget, so `timeoutMs` bounds how long the
 * call can take rather than how long each socket may sit idle.
 */
export const performRequest = async (spec: HttpRequestSpec): Promise<HttpExchange> => {
  const redirects: { status: number; location: string }[] = [];
  let currentUrl = new URL(spec.url);
  // The request as it stands on this hop. A redirect can rewrite the method and
  // drop the body, so the hop has to send `currentSpec` and not `spec` — the
  // earlier version mutated local variables that nothing read, which made the
  // request go out as POST while the report said GET.
  let currentSpec = spec;
  const deadline = Date.now() + spec.timeoutMs;
  const expired = (): TransportFailure =>
    new TransportFailure("timeout", `Request timed out after ${String(spec.timeoutMs)} ms`);

  for (let hop = 0; ; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw expired();
    const attempt: HttpRequestSpec = { ...currentSpec, timeoutMs: remaining };
    const send = async (): Promise<SingleShotResult> => {
      // `auto` starts on HTTP/1.1 and falls back to HTTP/2 in the catch below.
      if (attempt.httpVersion === "2") return performHttp2(attempt, currentUrl);
      return performHttp1(attempt, currentUrl);
    };

    const result = await send().catch(async (error: unknown) => {
      // HTTP/2 is a fallback for a *protocol* mismatch, not a general retry.
      // Only a peer that answered something this client could not parse is
      // evidence for it; anything else — a deadline, a refused connection, a
      // certificate — would be repeated over a different protocol and then
      // reported under whichever message came last. That is how a request that
      // timed out on the default configuration came back as an unreachable
      // endpoint: the deadline fired on HTTP/1.1, the error was discarded, and
      // h2's "Protocol error" from a plain HTTP/1.1 server was what the caller
      // was told.
      if (attempt.httpVersion !== "auto" || transportFailureKind(error) !== "protocol") {
        throw error;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw expired();
      return performHttp2({ ...attempt, timeoutMs: left }, currentUrl);
    });

    const location = result.headers["location"];
    const isRedirect = result.status >= 300 && result.status < 400 && location !== undefined;
    if (!spec.followRedirects || !isRedirect || hop >= spec.maxRedirects) {
      return {
        url: currentUrl.toString(),
        method: currentSpec.method,
        status: result.status,
        statusText: result.statusText,
        httpVersion: result.httpVersion,
        requestHttpVersion: spec.httpVersion,
        headers: result.headers,
        body: result.body,
        bodyBytes: result.body.byteLength,
        bodyTruncated: result.bodyTruncated,
        timing: result.timing,
        tls: result.tls,
        redirects,
      };
    }

    redirects.push({ status: result.status, location });
    currentUrl = new URL(location, currentUrl);
    // 303, and 301/302 in practice, turn everything into a GET and drop the body.
    // The rewrite is recorded in `currentSpec`, which is what the next hop sends.
    if (
      result.status === 303 ||
      ((result.status === 301 || result.status === 302) && currentSpec.method === "POST")
    ) {
      currentSpec = { ...currentSpec, method: "GET", body: undefined };
    }
  }
};

/** Decode a body as text when it plausibly is text. */
export const decodeBody = (
  body: Buffer,
  contentType: string | undefined,
): { text?: string; base64?: string; decodedAsText: boolean } => {
  const textual =
    contentType === undefined ||
    /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|soap\+xml|graphql)|.*\+(json|xml))/iu.test(
      contentType,
    );
  if (!textual) return { base64: body.toString("base64"), decodedAsText: false };
  const decoded = body.toString("utf8");
  // A NUL byte in the first kilobyte means this is not text, whatever the
  // Content-Type claims.
  if (decoded.slice(0, 1024).includes("\u0000")) {
    return { base64: body.toString("base64"), decodedAsText: false };
  }
  return { text: decoded, decodedAsText: true };
};
