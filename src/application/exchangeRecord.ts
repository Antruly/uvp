import { newId } from "../domain/identity.js";
import type { HttpExchange } from "./httpClient.js";
import type { ExchangeRecord, SessionStore } from "./sessionStore.js";

/**
 * Record an exchange in the session, so `uvp_assert_exchange` can re-evaluate it.
 *
 * Storing the raw bytes is what makes a re-run possible without a re-request: an
 * assertion evaluated twice against the same recorded exchange must give the same
 * answer, or the tool is measuring the network rather than the service.
 *
 * One function for every path that records an exchange, because the fields below
 * are not independent. `responseHeadersObserved` is the one that makes the shape of
 * this worth owning: a record whose headers are a subset has to say so, or a header
 * assertion reading it cannot tell a header the peer left out from one nobody
 * asked about. A second recording path written from scratch would be a second
 * answer to that, and it would be the one with the bug.
 */
export const rememberExchange = (
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
    /**
     * The response header names that were looked at, when narrower than all of
     * them. Left out by every caller that read the whole response.
     */
    readonly responseHeadersObserved?: readonly string[] | undefined;
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
    // `undefined` means "the whole set was read". A record with no response did
    // not read a whole set — or any set — so leaving it unset would turn a header
    // assertion into "absent" instead of "not looked at". A caller that observed
    // part of a response still names those names.
    responseHeadersObserved:
      exchange.responseHeadersObserved ?? (exchange.response === undefined ? [] : undefined),
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
