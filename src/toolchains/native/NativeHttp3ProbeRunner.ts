import {
  NativeProbeProcess,
  asBoolean,
  asNumber,
  asObject,
  asString,
  firstLine,
  reportBudgetFor,
} from "./NativeProbeProcess.js";
import type { NativeProbeProcessOptions, RawReport } from "./NativeProbeProcess.js";
import type {
  NativeHttp3Outcome,
  NativeHttp3Probe,
  NativeHttp3Report,
  NativeHttp3Request,
} from "../../application/NativeHttp3Probe.js";

/**
 * The native HTTP/3 probe.
 *
 * This class is the HTTP/3 half of `native/uvcpp-probe`: how a `NativeHttp3Request`
 * is written for it, and how its report is read back into the facts `application`
 * asked for — no more. Reaching the process at all is `NativeProbeProcess`'s, and
 * is shared with the WebSocket probe.
 *
 * Two asymmetries with the WebSocket runner, both because of the stack rather than
 * because of taste:
 *
 *   - A probe build must list `http3` in `--version` before this runner will use
 *     it. The exchange and the `exchanges` field arrived together, so a build whose
 *     `--version` does not list it is definitely one that cannot run it — a finding
 *     the shared layer states, not a fallback this file invents.
 *   - The report says which header names were *looked for*. The C ABI reads one
 *     response header at a time and has no header-list call, so there is no such
 *     thing as a complete header set on this stack, and `headersObserved` is what
 *     keeps a short list from reading as a complete one.
 */

/** The exchange name the probe dispatches on. */
const EXCHANGE = "http3";

/**
 * Whether a probe build must list `http3` in `--version` to be usable here.
 *
 * It must; see the note above.
 */
const LISTED_IN_VERSION = true;

/**
 * A ceiling on the body a caller may ask to keep, matching the probe's own default.
 *
 * Not a policy: past this the report would be a megabyte of someone else's page
 * travelling through a tool result, and the probe can report the body's real length
 * without carrying it.
 */
const DEFAULT_MAX_BODY_BYTES = 65_536;

export type NativeHttp3ProbeRunnerOptions = NativeProbeProcessOptions;

export class NativeHttp3ProbeRunner extends NativeProbeProcess implements NativeHttp3Probe {
  constructor(options: NativeHttp3ProbeRunnerOptions = {}) {
    super({ name: EXCHANGE, listedInVersion: LISTED_IN_VERSION }, options);
  }

  /**
   * Run one probe.
   *
   * Availability first, for the same reason the WebSocket runner does it: a probe
   * that is not there should be reported as a missing stack, not as a URL that
   * would not answer. On this exchange that check is also what establishes the
   * binary can run h3 at all, which is the failure mode with no useful symptom —
   * a build without the exchange would otherwise report a handshake that never
   * happened.
   */
  async probe(request: NativeHttp3Request, signal: AbortSignal): Promise<NativeHttp3Outcome> {
    const availability = await this.availability(signal);
    if (signal.aborted) return { kind: "cancelled" };
    if (availability.state !== "available") {
      return {
        kind: "stack-unavailable",
        state: availability.state,
        reason: availability.reason,
        ...(availability.path === undefined ? {} : { path: availability.path }),
      };
    }

    const outcome = await this.invoke(
      availability.path,
      {
        url: request.url,
        // The host, port, path and authority are passed as this layer parsed them
        // rather than as a URL for the probe to take apart again. uvp's URI parser
        // is the one owner of "what this URL means"; a second, simpler one inside
        // the probe would agree on the common shapes and disagree on the rest.
        host: request.host,
        port: request.port,
        path: request.path,
        method: request.method,
        // `undefined` here rather than an empty string: the probe fills in
        // `host:port` when `authority` is absent, and an empty string would be a
        // second way of saying the same thing that the probe treats differently.
        ...(request.authority === undefined ? {} : { authority: request.authority }),
        headers: request.headers.map((header) => ({ name: header.name, value: header.value })),
        // Both spellings travel. A probe that knows `body_base64` decodes it and
        // ignores `body`; one that predates it sends the text form, which is
        // exactly what it did before this field existed. Sending only the new
        // field would make an older probe send an empty body with no way to say
        // it had ignored anything.
        body: request.body,
        ...(request.bodyBase64 === undefined ? {} : { body_base64: request.bodyBase64 }),
        // Absent means "do not verify". The probe distinguishes absent from empty,
        // and an empty string would be read as a CA file it could not open.
        ...(request.caFile === undefined ? {} : { ca_file: request.caFile }),
        idle_ms: request.idleTimeoutMs,
        total_timeout_ms: request.totalTimeoutMs,
        max_body_bytes: request.maxBodyBytes,
      },
      signal,
      request.totalTimeoutMs,
      reportBudget(request),
    );
    if (typeof outcome === "string") {
      return { kind: "probe-failed", message: outcome, detail: "" };
    }
    if (outcome.aborted) return { kind: "cancelled" };
    if (outcome.timedOut) {
      return {
        kind: "probe-failed",
        message: this.timedOutMessage(request.totalTimeoutMs),
        detail: firstLine(outcome.stderr),
      };
    }

    const envelope = this.readEnvelope(outcome);
    if (envelope.kind === "request-refused") {
      return { kind: "request-refused", message: envelope.message };
    }
    if (envelope.kind === "cannot-run") {
      return {
        kind: "stack-unavailable",
        state: "unavailable",
        reason: envelope.message,
        path: availability.path,
      };
    }
    if (envelope.kind === "unreadable") {
      return { kind: "probe-failed", message: envelope.message, detail: envelope.detail };
    }

    const mapped = this.toReport(envelope.raw, availability.libraryVersion);
    return typeof mapped === "string"
      ? { kind: "probe-failed", message: mapped, detail: firstLine(outcome.stderr) }
      : { kind: "report", report: mapped };
  }

  /**
   * The report, as the port's facts — or a sentence saying why it could not be read.
   *
   * The same division the WebSocket runner makes: a field that is missing or of the
   * wrong type is version skew between uvp and the probe, not a fact about the
   * target, and there is no default for one that would not be invented.
   */
  private toReport(raw: RawReport, libraryVersion: string | undefined): NativeHttp3Report | string {
    if (!this.isProbeReport(raw)) {
      return `the native probe printed something that is not one of its reports`;
    }

    const url = asString(raw["url"]);
    const host = asString(raw["host"]);
    const port = asNumber(raw["port"]);
    const method = asString(raw["method"]);
    const path = asString(raw["path"]);
    const authority = asString(raw["authority"]);
    const verifyPeer = asBoolean(raw["verify_peer"]);
    const handshakeCompleted = asBoolean(raw["handshake_completed"]);
    const handshakeOk = asBoolean(raw["handshake_ok"]);
    const handshakeStatus = asNumber(raw["handshake_status"]);
    const alpn = asString(raw["alpn"]);
    const requestSent = asBoolean(raw["request_sent"]);
    const sendAttempts = asNumber(raw["send_attempts"]);
    const answered = asBoolean(raw["answered"]);
    const responseError = asNumber(raw["response_error"]);
    const body = asString(raw["body"]);
    const bodyBytes = asNumber(raw["body_bytes"]);
    const bytesIn = asNumber(raw["bytes_in"]);
    const bytesOut = asNumber(raw["bytes_out"]);
    const disconnected = asBoolean(raw["disconnected"]);
    const totalMs = asNumber(raw["total_ms"]);
    const rawHeaders = raw["headers"];
    const rawObserved = raw["headers_observed"];
    const notObservable = raw["not_observable"];
    // Named together rather than one at a time: a caller reading this has version
    // skew to fix, and the list of what is missing is the whole of what it needs.
    const missing = [
      url === undefined ? "url" : undefined,
      host === undefined ? "host" : undefined,
      port === undefined ? "port" : undefined,
      method === undefined ? "method" : undefined,
      path === undefined ? "path" : undefined,
      authority === undefined ? "authority" : undefined,
      verifyPeer === undefined ? "verify_peer" : undefined,
      handshakeCompleted === undefined ? "handshake_completed" : undefined,
      handshakeOk === undefined ? "handshake_ok" : undefined,
      handshakeStatus === undefined ? "handshake_status" : undefined,
      alpn === undefined ? "alpn" : undefined,
      requestSent === undefined ? "request_sent" : undefined,
      sendAttempts === undefined ? "send_attempts" : undefined,
      answered === undefined ? "answered" : undefined,
      responseError === undefined ? "response_error" : undefined,
      body === undefined ? "body" : undefined,
      bodyBytes === undefined ? "body_bytes" : undefined,
      bytesIn === undefined ? "bytes_in" : undefined,
      bytesOut === undefined ? "bytes_out" : undefined,
      disconnected === undefined ? "disconnected" : undefined,
      totalMs === undefined ? "total_ms" : undefined,
      !isHeaderMap(rawHeaders) ? "headers" : undefined,
      !Array.isArray(rawObserved) ? "headers_observed" : undefined,
      !Array.isArray(notObservable) ? "not_observable" : undefined,
    ].filter((name): name is string => name !== undefined);
    if (missing.length > 0) {
      return `the native probe's report is missing fields this uvp needs (${missing.join(", ")})`;
    }

    const stopReason = raw["stop_reason"];
    if (stopReason !== null && stopReason !== undefined && !isStopReason(stopReason)) {
      return `the native probe stopped for a reason this uvp does not know: ${JSON.stringify(stopReason)}`;
    }

    const rawError = asObject(raw["error"]);
    const bodyOmitted = asString(raw["body_omitted"]);

    return {
      url: url as string,
      host: host as string,
      port: port as number,
      method: method as string,
      path: path as string,
      authority: authority as string,
      verifyPeer: verifyPeer as boolean,
      handshakeCompleted: handshakeCompleted as boolean,
      handshakeOk: handshakeOk as boolean,
      handshakeStatus: handshakeStatus as number,
      alpn: alpn as string,
      requestSent: requestSent as boolean,
      // Null in the report when nothing was sent; see the port's own note on why
      // that is not the same as stream zero.
      streamId: asNumber(raw["stream_id"]),
      sendAttempts: sendAttempts as number,
      lastSendError: asNumber(raw["last_send_error"]),
      answered: answered as boolean,
      status: asNumber(raw["status"]),
      responseError: responseError as number,
      headers: rawHeaders as Readonly<Record<string, string>>,
      headersObserved: (rawObserved as readonly unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      ),
      body: body as string,
      bodyBytes: bodyBytes as number,
      bodyOmitted: bodyOmitted === "" ? undefined : bodyOmitted,
      bytesIn: bytesIn as number,
      bytesOut: bytesOut as number,
      disconnected: disconnected as boolean,
      error:
        rawError === undefined
          ? undefined
          : {
              what: asString(rawError["what"]) ?? "",
              code: asNumber(rawError["code"]) ?? 0,
            },
      stopReason: isStopReason(stopReason) ? stopReason : undefined,
      abandoned: asBoolean(raw["abandoned"]) ?? false,
      totalMs: totalMs as number,
      notObservable: (notObservable as readonly unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      ),
      libraryVersion,
    };
  }
}

/**
 * The run endings this uvp knows.
 *
 * `"answered"` is this exchange's own: the probe ends a run the moment a response
 * is taken rather than waiting out the idle deadline, which is the difference
 * between a 25 ms answer and a five-second one.
 */
const isStopReason = (value: unknown): value is "answered" | "idle" | "total" =>
  value === "answered" || value === "idle" || value === "total";

/**
 * Whether `value` is a header map: an object of name to string value.
 *
 * Checked as a whole rather than per entry, because there is nowhere for a bad
 * entry to go. A name-to-value map has no room for the shape this uvp does not
 * know, so the honest reading of one is "this is not the report I was built
 * against" rather than a dropped header.
 */
const isHeaderMap = (value: unknown): value is Record<string, string> => {
  const map = asObject(value);
  return map !== undefined && Object.values(map).every((entry) => typeof entry === "string");
};

/**
 * How many bytes this request's report may be.
 *
 * The report carries the response body, and a JSON string escapes a byte as up to
 * six characters (`\u0000`), so the body's own cap is multiplied by six. What that
 * buys is a report that cannot be truncated by the *caller's* own numbers: a
 * truncation here reads as a probe that failed, which would be a finding about the
 * probe derived from a bound the caller set.
 */
const reportBudget = (request: NativeHttp3Request): number =>
  reportBudgetFor(
    (request.maxBodyBytes <= 0 ? DEFAULT_MAX_BODY_BYTES : request.maxBodyBytes) * 6 + 8 * 1024,
  );
