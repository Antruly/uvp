import { UvpFailure } from "../domain/errors.js";
import { sha256 } from "../domain/identity.js";
import { performRequest } from "./httpClient.js";
import type { HttpExchange } from "./httpClient.js";
import { TRANSPORT_BODY_LIMIT_BYTES } from "./httpClient.js";
import type { CaptureSession, ExchangeRecord } from "./sessionStore.js";
import type { EvidenceRecorder } from "./evidenceHelpers.js";
import {
  coverageComplete,
  coveragePartial,
  coverageUnknown,
  endpointSource,
  record,
  recordUnknown,
} from "./evidenceHelpers.js";

/**
 * Replaying a capture, kept apart from the session that recorded it.
 *
 * A capture session is a proxy with a notebook; a replay is a client with a
 * script. They share the notebook and nothing else — no listener, no port, no
 * lifecycle — and the separation is what lets `CaptureService` stay the owner of
 * *when* a session exists and this module own *what the record means*.
 *
 * The session and the window arrive resolved. Which exchanges a caller asked for
 * is the service's question, because the same cursor and limit answer it for
 * `uvp_capture_read`; by the time anything here runs, the window is a list.
 *
 * Three decisions shape everything below:
 *
 *   - **A method that writes is not replayed at all.** A `POST` replayed is a
 *     second write, and nothing here knows whether the endpoint is idempotent.
 *     It is counted, named, and never sent.
 *   - **A comparison with no ground is not a pass.** An exchange whose recorded
 *     call failed carries no response; a response recorded cut short by the
 *     session's own limit is a prefix. Both are `not_comparable`, and a record
 *     with no response at all is not compared against an empty one.
 *   - **What was compared is stated per exchange.** `compared` names the fields
 *     that were actually put side by side, so a status-only match is legible
 *     rather than indistinguishable from a full one.
 *
 * The recorded URL is the *upstream* URL — that is what the capture writes down,
 * because it is what the exchange was. So a replay with no target goes to the
 * session's own upstream, and a replay with one keeps every recorded path and
 * query while replacing the origin.
 */

/**
 * The methods a replay is willing to send.
 *
 * `GET`, `HEAD`, and `OPTIONS` are defined as safe: a client may send them again
 * without asking the service to change. Everything else is refused and reported,
 * which is what makes `mutatesTarget: false` in the contract a statement about
 * this set rather than a hope about the endpoint.
 */
const REPLAYABLE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Request headers that describe a connection, or that the transport recomputes.
 *
 * These were recorded, because a capture keeps the bytes that crossed the wire,
 * but they are not part of the *request* a replay is making. `host` would name
 * the origin the capture forwarded to rather than the one being replayed
 * against; `content-length` would describe the body the client sent rather than
 * the one being sent now, and `performRequest` sets it from the body it has;
 * the rest are properties of a connection that no longer exists.
 *
 * Everything else is replayed as recorded, authorization and cookies included —
 * a replay that quietly dropped them would put a different question to the
 * service and report the answer as a regression.
 */
const CONNECTION_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
]);

/** Which recorded facts a single exchange's replay was able to compare. */
export type ReplayField = "status" | "body";

export type ReplayExchangeOutcome = "matched" | "differs" | "skipped" | "not_comparable";

/**
 * What a whole replay established.
 *
 * Four values rather than a boolean, because the interesting cases are the last
 * three: a replay that compared nothing has not verified anything, and calling it
 * a pass is the failure this tool exists to avoid. `partial` covers an exchange
 * that was not sent, one with no ground to compare against, and one that answered
 * as recorded on fewer facts than the record holds — a status that matched while
 * the body was never looked at is not a verified exchange.
 */
export type ReplayVerdict = "verified" | "failed" | "partial" | "unknown";

export interface ReplayInput {
  readonly since_id: string | undefined;
  /** Origin to replay against. Defaults to the session's own upstream. */
  readonly target: string | undefined;
  /** Added to every replayed request, overriding a recorded header of that name. */
  readonly headers: Readonly<Record<string, string>>;
  readonly limit: number;
  readonly timeout_ms: number;
  readonly verify_tls: boolean;
}

/**
 * What a caller hands `CaptureService.replay`: the window selector plus the
 * replay's own parameters.
 *
 * `capture_id` is here and not in `ReplayInput` because it selects the session,
 * which is the service's question — by the time `replayCapture` runs, the session
 * is already in hand and there is nothing left to look up.
 */
export interface ReplayRequest extends ReplayInput {
  readonly capture_id: string | undefined;
}

export interface ReplayExchangeResult {
  readonly exchange_id: string;
  readonly method: string;
  /** Where the exchange was recorded from, which is the upstream at capture time. */
  readonly url: string;
  /** Where this replay actually sent it. Equal to `url` unless a target was given. */
  readonly replayed_url: string;
  readonly outcome: ReplayExchangeOutcome;
  /** Why it was skipped, or why part of the comparison was left out. */
  readonly reason?: string;
  /** What was compared. Empty for `skipped` and for a comparison with no ground. */
  readonly compared: readonly ReplayField[];
  readonly recorded_status?: number;
  readonly observed_status?: number;
  readonly recorded_body_digest?: string;
  readonly observed_body_digest?: string;
  /** Why the replayed call did not complete. The record is still reported. */
  readonly error?: string;
}

export interface ReplayResult {
  readonly capture_id: string;
  readonly running: boolean;
  readonly target: string;
  readonly replayed: number;
  readonly matched: number;
  readonly differed: number;
  readonly skipped: number;
  readonly not_comparable: number;
  /** The distinct methods that were not sent, so a count is never a puzzle. */
  readonly skipped_methods: readonly string[];
  readonly outcome: ReplayVerdict;
  readonly exchanges: readonly ReplayExchangeResult[];
  readonly total_recorded: number;
  readonly withheld_by_limit: number;
  readonly withheld_by_retention: number;
  readonly since_id_unknown: boolean;
  readonly body_limit_bytes: number;
}

/**
 * The exchanges a replay is to send, already resolved by the session's owner.
 *
 * `withheldByLimit` and `sinceIdUnknown` travel with the list because they are
 * facts about the *window* — what this replay was not asked to send — and
 * recomputing them here would be a second reading of the same cursor.
 */
export interface ReplayWindow {
  readonly session: CaptureSession;
  /** The exchanges to replay, oldest first. */
  readonly exchanges: readonly ExchangeRecord[];
  readonly withheldByLimit: number;
  readonly sinceIdUnknown: boolean;
}

/**
 * The origin a replay will be sent to, from whatever the caller and the session
 * between them provide.
 *
 * A path is refused rather than merged. A caller who writes
 * `http://host:8080/api` is asking for one of two things — "put the recorded
 * paths under `/api`" or "only replay the recorded exchanges that were under
 * `/api`" — and there is no way to tell which. Guessing puts a request
 * somewhere nobody asked for, so the refusal names the origin it would have used.
 */
export const replayTarget = (raw: string | undefined): URL => {
  if (raw === undefined) {
    throw new UvpFailure({
      code: "invalid_request",
      message: "This capture session has no upstream, so there is nothing to replay it against.",
      remediation: {
        action:
          "Pass target, for example http://127.0.0.1:8080. A session started without upstream records " +
          "only the exchanges it matched and forwarded; each record holds the URL it was recorded " +
          "from, and a target says which origin to send it to now.",
      },
    });
  }
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new UvpFailure({
      code: "invalid_request",
      message: `The replay target "${raw}" is not an absolute URL.`,
      remediation: { action: "Pass target as an absolute URL, such as http://127.0.0.1:8080." },
    });
  }
  if (target.pathname !== "/" && target.pathname !== "") {
    throw new UvpFailure({
      code: "invalid_request",
      message: `The replay target "${raw}" carries a path, and a replay keeps each recorded path and query.`,
      remediation: {
        action:
          `Pass just the origin, for example ${target.origin}. Every recorded exchange is replayed at ` +
          "its own recorded path, so a path on the target would have to mean either a prefix to add " +
          "or a prefix to select, and uvp will not choose for you.",
      },
    });
  }
  return target;
};

/**
 * Which of a record's facts the replay is entitled to hold it to.
 *
 * Kept apart from the call that produces `observed` because this is the part a
 * replay is most likely to get subtly wrong, and the wrong versions look right:
 * a digest of a body the session cut at its own limit compares one byte range
 * with a longer one and reports "differs", which reads exactly like a regression
 * in the service. `omissions` says, in words, every fact that was left out and
 * why, so a `compared` list that is shorter than a caller expects is explained
 * rather than merely visible.
 */
const compareExchange = (
  recorded: ExchangeRecord,
  observed: HttpExchange | undefined,
  maxBodyBytes: number,
): {
  readonly compared: ReplayField[];
  readonly omissions: string[];
  readonly differs: boolean;
} => {
  if (observed === undefined) {
    return {
      compared: [],
      omissions: ["the replay did not complete, so there was no response to compare"],
      differs: false,
    };
  }

  const compared: ReplayField[] = [];
  const omissions: string[] = [];
  let differs = false;

  if (recorded.status === undefined) {
    omissions.push(
      "the recorded exchange carries no response: the upstream call failed when it was captured",
    );
  } else {
    compared.push("status");
    if (recorded.status !== observed.status) differs = true;
  }

  const body = compareBody(recorded, observed, maxBodyBytes);
  if (body.field !== undefined) compared.push(body.field);
  if (body.omission !== undefined) omissions.push(body.omission);
  if (body.differs) differs = true;

  return { compared, omissions, differs };
};

/** The body half of the comparison, which is the half with the ways to be wrong. */
const compareBody = (
  recorded: ExchangeRecord,
  observed: HttpExchange,
  maxBodyBytes: number,
): { readonly field?: ReplayField; readonly omission?: string; readonly differs: boolean } => {
  if (recorded.responseBody === undefined) {
    // A record with no response at all has already been described as such; the
    // same sentence twice is how a caller learns to stop reading reasons.
    return recorded.status === undefined
      ? { differs: false }
      : { differs: false, omission: "no response body was recorded" };
  }
  if (recorded.responseBodyTruncated) {
    return {
      differs: false,
      omission:
        `the recorded body was cut at the session's ${String(maxBodyBytes)}-byte recording limit, so ` +
        "it is a prefix and its digest describes fewer bytes than the response had",
    };
  }
  if (observed.bodyTruncated) {
    return {
      differs: false,
      omission: `the replayed response exceeded the transport's ${String(TRANSPORT_BODY_LIMIT_BYTES)}-byte read limit, so its body is a prefix`,
    };
  }
  return {
    field: "body",
    differs: sha256(recorded.responseBody) !== sha256(observed.body),
  };
};

/**
 * Exchanges that answered as recorded, but on fewer facts than the record holds.
 *
 * A digest cannot be taken of a body one side cut short, so `matched` may mean
 * "the status matched and the body could not be looked at". That is a weaker
 * claim than a caller reading `matched` would assume, and it is the reason the
 * verdict below is not simply a count of differences.
 */
const incompletelyCompared = (
  exchanges: readonly ReplayExchangeResult[],
): readonly ReplayExchangeResult[] =>
  exchanges.filter(
    (entry) =>
      (entry.outcome === "matched" || entry.outcome === "differs") && entry.reason !== undefined,
  );

/**
 * The sentences a replay has to carry, assembled from what actually happened.
 *
 * Only the ones that apply: a limitation list that says the same three things on
 * every run is one a caller stops reading, and the run where the body limit bit
 * is exactly the run where that sentence has to be visible.
 */
const replayLimitations = (
  exchanges: readonly ReplayExchangeResult[],
  session: CaptureSession,
  partial: readonly ReplayExchangeResult[],
): readonly string[] => {
  const limitations = [
    "A replayed response is compared with the bytes recorded at capture time, so a value that differs " +
      "between two requests — a timestamp, a nonce, a request id — is reported as a difference.",
    "Host, content-length and the other connection headers are recomputed from the target rather than " +
      "replayed; every other recorded request header is sent as it was recorded, authorization and " +
      "cookies included, unless the caller overrode it.",
  ];
  const skipped = exchanges.filter((entry) => entry.outcome === "skipped");
  if (skipped.length > 0) {
    limitations.push(
      `${String(skipped.length)} recorded exchange(s) were not sent at all (${[...new Set(skipped.map((entry) => entry.method.toUpperCase()))].sort().join(", ")}), ` +
        "because replaying a method that writes would write a second time",
    );
  }
  const notComparable = exchanges.filter((entry) => entry.outcome === "not_comparable").length;
  if (notComparable > 0) {
    limitations.push(
      `${String(notComparable)} replayed exchange(s) produced nothing comparable with their record; ` +
        "each one names its own reason",
    );
  }
  if (partial.length > 0) {
    limitations.push(
      `${String(partial.length)} exchange(s) were compared on fewer facts than the record holds: bodies ` +
        `are compared only when both sides are whole, which means neither the session's ` +
        `${String(session.maxBodyBytes)}-byte recording limit nor the transport's ` +
        `${String(TRANSPORT_BODY_LIMIT_BYTES)}-byte read limit cut one of them`,
    );
  }
  if (session.retention.withheld > 0) {
    limitations.push(
      `${String(session.retention.withheld)} recorded exchange(s) had already been dropped from this ` +
        `session by its retention budget of ${String(session.retention.byteBudget)} bytes, so they could ` +
        "not be replayed",
    );
  }
  return limitations;
};

/**
 * Replay a window of a capture, and report what still answers the same.
 *
 * This is the other half of a capture. A session records what a client sent and
 * what came back; replaying it puts the same requests to a service again — the
 * one that just restarted, the one built from the branch — and asks whether the
 * answers are still the answers. It is a regression suite with no test file to
 * write, because the traffic already exists.
 */
export const replayCapture = async (
  window: ReplayWindow,
  input: ReplayInput,
  recorder: EvidenceRecorder,
): Promise<ReplayResult> => {
  const { session } = window;
  const target = replayTarget(input.target ?? session.upstream);

  const exchanges: ReplayExchangeResult[] = [];
  for (const recorded of window.exchanges) {
    exchanges.push(await replayOne(recorded, target, input, session.maxBodyBytes));
  }

  const countOf = (outcome: ReplayExchangeOutcome): number =>
    exchanges.filter((entry) => entry.outcome === outcome).length;
  const matched = countOf("matched");
  const differed = countOf("differs");
  const skipped = countOf("skipped");
  const notComparable = countOf("not_comparable");
  const comparedCount = matched + differed;
  const partial = incompletelyCompared(exchanges);

  // Nothing compared is not a pass, and something compared that disagreed is not
  // a partial one. The order matters: a run with one difference and one skipped
  // exchange is a failure, and reporting it as "partial" would bury the
  // difference under a coverage note.
  const outcome: ReplayVerdict =
    comparedCount === 0
      ? "unknown"
      : differed > 0
        ? "failed"
        : skipped + notComparable + partial.length > 0
          ? "partial"
          : "verified";

  const skippedMethods = [
    ...new Set(
      exchanges
        .filter((entry) => entry.outcome === "skipped")
        .map((entry) => entry.method.toUpperCase()),
    ),
  ].sort();

  record(recorder, {
    kind: "capture",
    subject: { capture_id: session.captureId, target: target.origin },
    observed: {
      outcome,
      replayed: matched + differed + notComparable,
      matched,
      differed,
      skipped,
      skipped_methods: skippedMethods,
      not_comparable: notComparable,
      withheld_by_limit: window.withheldByLimit,
      withheld_by_retention: session.retention.withheld,
    },
    coverage:
      comparedCount === 0
        ? coverageUnknown(
            "capture replay",
            window.exchanges.length === 0
              ? "the capture held no exchange to replay"
              : "no replayed exchange produced anything comparable with its record",
          )
        : skipped + notComparable + partial.length > 0
          ? coveragePartial(
              "capture replay",
              `${String(skipped)} exchange(s) were not sent, ${String(notComparable)} had nothing ` +
                `comparable, and ${String(partial.length)} were compared on fewer facts than the record holds`,
              comparedCount,
              window.exchanges.length,
            )
          : coverageComplete("capture replay"),
    sources: [endpointSource(target.origin)],
    limitations: replayLimitations(exchanges, session, partial),
  });

  if (comparedCount === 0) {
    recordUnknown(
      recorder,
      "Does the target still answer the captured exchanges the way it did?",
      "not_attempted",
      {
        blockedBy:
          window.exchanges.length === 0
            ? "the capture holds no exchange for this cursor and limit"
            : "no replayed exchange produced a response that could be compared with its record",
      },
    );
  }

  return {
    capture_id: session.captureId,
    running: !session.stopped,
    target: target.origin,
    replayed: matched + differed + notComparable,
    matched,
    differed,
    skipped,
    not_comparable: notComparable,
    skipped_methods: skippedMethods,
    outcome,
    exchanges,
    total_recorded: session.retention.recorded,
    withheld_by_limit: window.withheldByLimit,
    withheld_by_retention: session.retention.withheld,
    since_id_unknown: window.sinceIdUnknown,
    body_limit_bytes: session.maxBodyBytes,
  };
};

/**
 * One replayed exchange, and what could be said about it.
 *
 * `reason` is present whenever the comparison was less than the whole exchange —
 * skipped, not comparable, or compared on the status alone. A `compared` list
 * that quietly omitted the body would leave a caller to work out why, and the
 * answer is different in each of those three cases.
 */
const replayOne = async (
  recorded: ExchangeRecord,
  target: URL,
  input: ReplayInput,
  // The session's own recording limit, so a body it cut short can say by how
  // much. Taken from the session rather than from the request, because it is a
  // property of the capture the record came from and not of the replay.
  maxBodyBytes: number,
): Promise<ReplayExchangeResult> => {
  const recordedUrl = new URL(recorded.url);
  const url = new URL(`${recordedUrl.pathname}${recordedUrl.search}`, target);
  const base = {
    exchange_id: recorded.exchangeId,
    method: recorded.method,
    url: recorded.url,
    replayed_url: url.toString(),
    ...(recorded.status === undefined ? {} : { recorded_status: recorded.status }),
  };

  const method = recorded.method.toUpperCase();
  if (!REPLAYABLE_METHODS.has(method)) {
    return {
      ...base,
      outcome: "skipped",
      reason:
        `${method} was not replayed: sending it again would be a second write, and nothing here ` +
        "knows whether the endpoint is idempotent",
      compared: [],
    };
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(recorded.requestHeaders)) {
    if (!CONNECTION_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  // The caller's own headers come last and are not filtered: a header given
  // explicitly is a statement about this replay, not a leftover from the
  // connection the exchange arrived on.
  Object.assign(headers, input.headers);

  let observed: HttpExchange | undefined;
  let error: string | undefined;
  try {
    observed = await performRequest({
      url: url.toString(),
      method,
      headers,
      body: recorded.requestBody,
      httpVersion: "auto",
      followRedirects: false,
      maxRedirects: 0,
      verifyTls: input.verify_tls,
      timeoutMs: input.timeout_ms,
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const { compared, omissions, differs } = compareExchange(recorded, observed, maxBodyBytes);
  const outcome: ReplayExchangeOutcome =
    compared.length === 0 ? "not_comparable" : differs ? "differs" : "matched";

  // A digest only for a side whose bytes are whole. Reporting the digest of a
  // body a limit cut would put a number in the result that looks exactly like the
  // number a full comparison would have produced, and a caller comparing it with
  // a digest from another run would be comparing a prefix with a whole.
  const whole = (body: Buffer | undefined, truncated: boolean): Buffer | undefined =>
    body === undefined || truncated ? undefined : body;

  const recordedWhole = whole(recorded.responseBody, recorded.responseBodyTruncated);
  const observedWhole =
    observed === undefined ? undefined : whole(observed.body, observed.bodyTruncated);

  return {
    ...base,
    outcome,
    ...(omissions.length === 0 ? {} : { reason: omissions.join("; ") }),
    compared,
    ...(observed === undefined ? {} : { observed_status: observed.status }),
    ...(recordedWhole === undefined ? {} : { recorded_body_digest: sha256(recordedWhole) }),
    ...(observedWhole === undefined ? {} : { observed_body_digest: sha256(observedWhole) }),
    ...(error === undefined ? {} : { error }),
  };
};
