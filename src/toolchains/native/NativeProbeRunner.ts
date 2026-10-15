import { closeFrameReceived } from "./closeCodes.js";
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
  NativeProbeFrame,
  NativeProbeOutcome,
  NativeProbeReport,
  NativeProbeRequest,
  NativeWebSocketProbe,
} from "../../application/NativeWebSocketProbe.js";

/**
 * The native WebSocket probe.
 *
 * This class is the WebSocket half of `native/uvcpp-probe`: how a
 * `NativeProbeRequest` is written for it, and how its report is read back into
 * the facts `application` asked for — no more. Every judgement about what those
 * facts mean for a tool result belongs to `WebService`; the job here is to be
 * faithful about what was observed and explicit about what was not.
 *
 * Reaching the process at all — where the binary is, whether it works, running it
 * with a bounded budget, sorting its exit codes — is `NativeProbeProcess`'s, and
 * is shared with the HTTP/3 probe. This file adds the one thing that is not: the
 * shape of this exchange.
 */

/** The exchange name the probe dispatches on. */
const EXCHANGE = "websocket";

/**
 * Whether a probe build must list `websocket` in `--version` to be usable here.
 *
 * It must not, and that is a deliberate asymmetry with the HTTP/3 probe. This
 * exchange predates the exchange list, and for a while it *was* the probe, so
 * every probe ever built speaks it — including ones whose `--version` has no
 * `exchanges` field at all. Requiring the field would refuse a binary that works.
 * The HTTP/3 probe requires it because that exchange and the field arrived
 * together, so a build without the field is definitely one that cannot run it.
 */
const LISTED_IN_VERSION = false;

export type NativeProbeRunnerOptions = NativeProbeProcessOptions;

export class NativeProbeRunner extends NativeProbeProcess implements NativeWebSocketProbe {
  constructor(options: NativeProbeRunnerOptions = {}) {
    super({ name: EXCHANGE, listedInVersion: LISTED_IN_VERSION }, options);
  }

  /**
   * Run one probe.
   *
   * Availability first, and deliberately so: the same missing binary produces a
   * refusal here that names the file, where letting the spawn fail would produce
   * an error about a URL. The cost is one extra short-lived process per call.
   */
  async probe(request: NativeProbeRequest, signal: AbortSignal): Promise<NativeProbeOutcome> {
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
        idle_ms: request.idleTimeoutMs,
        total_timeout_ms: request.totalTimeoutMs,
        max_frames: request.maxFrames,
        max_frame_bytes: request.maxFrameBytes,
        // No `expect`: the question "did a received frame contain this text" is
        // answered once, in `WebService`, for both stacks. Sending it here would put
        // a second matcher in play with its own idea of which frames count.
        send: request.send.map((message) =>
          message.encoding === "base64"
            ? { binary_base64: message.payload, wait_ms: message.waitMs }
            : { text: message.payload, wait_ms: message.waitMs },
        ),
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
      // The probe was given its own ceiling plus slack and still had to be
      // killed, which is a fact about the probe rather than about the far end.
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
    // A report that arrived but could not be read is version skew between uvp
    // and the probe, not an observation about the target: said as such.
    return typeof mapped === "string"
      ? { kind: "probe-failed", message: mapped, detail: firstLine(outcome.stderr) }
      : { kind: "report", report: mapped };
  }

  /**
   * The report, as the port's facts — or a sentence saying why it could not be read.
   *
   * Returning a string for a failure rather than throwing keeps the one caller
   * linear: every path below is a shape the C++ side either always produces or
   * never does, and a field that is missing or of the wrong type is version skew
   * rather than a fact about the target.
   */
  private toReport(raw: RawReport, libraryVersion: string | undefined): NativeProbeReport | string {
    if (!this.isProbeReport(raw)) {
      return `the native probe printed something that is not one of its reports`;
    }
    const url = asString(raw["url"]);
    const upgraded = asBoolean(raw["opened"]);
    const totalMs = asNumber(raw["total_ms"]);
    const framesReceived = asNumber(raw["frames_received"]);
    const framesWithheld = asNumber(raw["frames_withheld"]);
    const notObservable = raw["not_observable"];
    if (
      url === undefined ||
      upgraded === undefined ||
      totalMs === undefined ||
      framesReceived === undefined ||
      framesWithheld === undefined ||
      !Array.isArray(notObservable)
    ) {
      return "the native probe's report is missing fields this uvp needs (url, opened, total_ms, frames_received, frames_withheld, not_observable)";
    }

    const frames: NativeProbeFrame[] = [];
    const rawFrames = raw["frames"];
    if (!Array.isArray(rawFrames)) return "the native probe's report carries no frame log";
    for (const entry of rawFrames) {
      const frame = toFrame(entry);
      if (typeof frame === "string") return frame;
      frames.push(frame);
    }

    const rawClose = asObject(raw["close"]);
    const closeCode = rawClose === undefined ? undefined : asNumber(rawClose["code"]);
    const rawError = asObject(raw["error"]);
    const stopReason = raw["stop_reason"];
    if (stopReason !== null && stopReason !== "idle" && stopReason !== "total") {
      return `the native probe stopped for a reason this uvp does not know: ${JSON.stringify(stopReason ?? null)}`;
    }

    return {
      url,
      upgraded,
      frames,
      framesReceived,
      framesWithheld,
      peerClosed: asBoolean(raw["peer_closed"]) ?? false,
      close:
        closeCode === undefined
          ? undefined
          : {
              code: closeCode,
              reason: asString(rawClose?.["reason"]) ?? "",
              closeFrameReceived: closeFrameReceived(closeCode),
            },
      closeSentByProbe: asBoolean(raw["close_sent_by_probe"]) ?? false,
      error:
        rawError === undefined
          ? undefined
          : {
              what: asString(rawError["what"]) ?? "",
              code: asNumber(rawError["code"]) ?? 0,
            },
      stopReason: stopReason === null || stopReason === undefined ? undefined : stopReason,
      abandoned: asBoolean(raw["abandoned"]) ?? false,
      totalMs,
      notObservable: notObservable.filter((entry): entry is string => typeof entry === "string"),
      loopReturn: asNumber(raw["loop_return"]),
      libraryVersion,
    };
  }
}

/**
 * One entry of the report's frame log, or a sentence saying which entry this uvp
 * does not know.
 *
 * Every branch here is a shape the C++ side either always produces or never does.
 * An entry that matches neither is version skew between uvp and the probe, and
 * saying so is the only honest option: there is no default that would not be a
 * frame's worth of invented fact.
 */
const toFrame = (entry: unknown): NativeProbeFrame | string => {
  const frame = asObject(entry);
  const direction = frame === undefined ? undefined : asString(frame["direction"]);
  const opcode = frame === undefined ? undefined : asString(frame["opcode"]);
  const bytes = frame === undefined ? undefined : asNumber(frame["bytes"]);
  const atMs = frame === undefined ? undefined : asNumber(frame["at_ms"]);
  if (
    frame === undefined ||
    (direction !== "sent" && direction !== "received") ||
    (opcode !== "text" && opcode !== "binary") ||
    bytes === undefined ||
    atMs === undefined
  ) {
    return `the native probe's frame log carries an entry this uvp does not know: ${JSON.stringify(entry ?? null)}`;
  }
  const omitted = asString(frame["text_omitted"]);
  if (omitted !== undefined && omitted !== "truncated" && omitted !== "invalid-utf8") {
    return `the native probe omitted a frame's text for a reason this uvp does not know: ${JSON.stringify(omitted)}`;
  }
  const text = asString(frame["text"]);
  const base64 = asString(frame["base64"]);
  return {
    direction,
    opcode,
    bytes,
    atMs,
    truncated: asBoolean(frame["truncated"]) ?? false,
    ...(text === undefined ? {} : { text }),
    ...(base64 === undefined ? {} : { base64 }),
    ...(omitted === undefined ? {} : { textOmitted: omitted }),
  };
};

/**
 * How many bytes this request's report may be.
 *
 * The frame log holds at most `maxFrames` frames, each at most `maxFrameBytes` of
 * payload, and a binary frame arrives base64-encoded with a third again as many
 * bytes — so that, plus room for the JSON around it.
 */
const reportBudget = (request: NativeProbeRequest): number =>
  reportBudgetFor(
    (request.maxFrames + request.send.length) * (Math.ceil((request.maxFrameBytes * 4) / 3) + 512),
  );
