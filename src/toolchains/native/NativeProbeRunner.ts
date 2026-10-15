import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";

import { runProcess } from "../processRunner.js";
import type { ProcessOutcome, RunProcessOptions } from "../processRunner.js";
import { closeFrameReceived } from "./closeCodes.js";
import type {
  NativeProbeAvailability,
  NativeProbeFrame,
  NativeProbeOutcome,
  NativeProbeReport,
  NativeProbeRequest,
  NativeWebSocketProbe,
} from "../../application/NativeWebSocketProbe.js";

/**
 * The native WebSocket probe, as a supervised process.
 *
 * `native/uvcpp-probe` is a small C++ program that links libuvcpp's C ABI, reads
 * one JSON request on stdin, and writes one JSON report on stdout. This class
 * locates it, runs it, and turns its report into the facts `application` asked
 * for — no more. Every judgement about what those facts mean for a tool result
 * belongs to `WebService`; the job here is to be faithful about what was
 * observed and explicit about what was not.
 *
 * Three properties the C++ side establishes, and which the code below depends on
 * rather than re-deriving:
 *
 *   - The report is written to stdout as exactly one JSON object, on every exit
 *     path including the refusals. So a refusal is *read*, not guessed at from
 *     an exit code alone.
 *   - Exit 2 is "the request is wrong", exit 3 is "this probe cannot run here".
 *     A run that the probe's own watchdog ended is still an exit 0 with a report.
 *   - The probe bounds itself. It writes the report at its deadline and ends the
 *     process, because the C ABI's client loop cannot be woken from another
 *     thread. The supervisor's timeout below is therefore a backstop for a probe
 *     that failed to do that, and hitting it means the run is *unknown*, not that
 *     the target was slow.
 *
 * The binary is not vendored and not built on demand: building it needs a C++
 * toolchain and a libuvcpp built with `UVCPP_ENABLE_CAPI=ON`, and a probe call
 * that silently started a five-minute compile would be a tool call nobody can
 * bound. `npm run build:native-probe` builds it, `UVP_NATIVE_PROBE` points at a
 * build somewhere else, and a host with neither is reported as unavailable.
 */

/** The probe's own exit codes, from `native/uvcpp-probe/main.cpp`. */
const EXIT_OK = 0;
const EXIT_BAD_REQUEST = 2;
const EXIT_CANNOT_RUN = 3;

/** The marker every report starts with, so a stray file is not mistaken for one. */
const PROBE_ID = "uvcpp-capi";

const DEFAULT_AVAILABILITY_TIMEOUT_MS = 5_000;

/**
 * How long past the probe's own ceiling the supervisor waits before killing it.
 *
 * The probe's ceiling is `total_timeout_ms`; this is the slack for the process
 * to write its report and exit. Anything beyond it means the probe did not end
 * as it promises to, so the run is reported as failed rather than as a result.
 */
const DEFAULT_KILL_GRACE_MS = 3_000;

/** The floor for a report's byte budget, so a tiny probe still fits its own JSON. */
const MIN_REPORT_BYTES = 64 * 1024;

/** A ceiling as well as a floor: `max_frames` is the caller's number, not a licence. */
const MAX_REPORT_BYTES = 32 * 1024 * 1024;

/** `--version` output is one small object; anything larger is not this probe. */
const VERSION_BYTES = 8 * 1024;

type RunProcess = (options: RunProcessOptions) => Promise<ProcessOutcome>;

export interface NativeProbeRunnerOptions {
  /** Where `UVP_NATIVE_PROBE` is read from. Defaults to the process environment. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * The directory this module was loaded from, used to derive the default
   * candidate. Defaults to `import.meta.dirname`, which is inside `dist/` in a
   * build and inside `src/` when the source lanes run — both three levels below
   * the repository root, which is what makes one relative path work for both.
   */
  readonly moduleDirectory?: string | undefined;
  readonly availabilityTimeoutMs?: number | undefined;
  readonly killGraceMs?: number | undefined;
  /** Injected by tests. The real one spawns a child process. */
  readonly runProcess?: RunProcess | undefined;
}

/** Where a probe binary was looked for, and what is there. */
interface Candidate {
  readonly path: string;
  /** How this path was chosen, in the words a report should use. */
  readonly source: string;
}

const binaryName = (): string => (process.platform === "win32" ? "uvcpp-probe.exe" : "uvcpp-probe");

/** The JSON a report is, as far as this file reads it. */
type RawReport = Record<string, unknown>;

const asObject = (value: unknown): RawReport | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawReport)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/** The first JSON object in `text`, or nothing: a probe writes exactly one. */
const parseObject = (text: string): RawReport | undefined => {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  try {
    return asObject(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
};

/**
 * One line of what the probe said, for a caller who has to read a failure.
 *
 * The probe writes a one-line explanation to stderr as well as the report to
 * stdout, and on a refusal that explanation is the whole value of the run. A
 * report that arrived is preferred over it, so this is only used when there is
 * no report to quote.
 */
const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

export class NativeProbeRunner implements NativeWebSocketProbe {
  private readonly env: NodeJS.ProcessEnv;
  private readonly candidates: readonly Candidate[];
  private readonly availabilityTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly run: RunProcess;

  constructor(options: NativeProbeRunnerOptions = {}) {
    this.env = options.env ?? process.env;
    const moduleDirectory = options.moduleDirectory ?? import.meta.dirname;
    // A caller who named a binary gets that binary or a report of why not. Falling
    // back to another one would mean `UVP_NATIVE_PROBE` could be set to something
    // wrong and the tool would quietly probe with something else.
    const named = this.env["UVP_NATIVE_PROBE"];
    this.candidates =
      named === undefined || named === ""
        ? [
            {
              path: resolve(
                moduleDirectory,
                "..",
                "..",
                "..",
                ".cache",
                "native-probe",
                "build",
                binaryName(),
              ),
              source:
                "the build cache this repository writes (`npm run build:native-probe`), or UVP_NATIVE_PROBE",
            },
          ]
        : [{ path: resolve(named), source: "UVP_NATIVE_PROBE" }];
    this.availabilityTimeoutMs = options.availabilityTimeoutMs ?? DEFAULT_AVAILABILITY_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.run = options.runProcess ?? runProcess;
  }

  /**
   * Whether the stack can be used here.
   *
   * Two questions, in order, because they fail differently: is there a file to
   * run, and does what is there work. `--version` is the second — the probe
   * answers it by reporting the C ABI it was built against and the library it
   * loaded, and refuses (exit 3) when the two disagree. That mismatch is the
   * failure mode with no useful symptom, so it is checked before anything
   * connects to anything.
   */
  async availability(signal: AbortSignal): Promise<NativeProbeAvailability> {
    const examined: string[] = [];
    let undetermined: { readonly reason: string; readonly path: string } | undefined;

    for (const candidate of this.candidates) {
      try {
        accessSync(candidate.path, constants.X_OK);
      } catch (cause) {
        examined.push(`${candidate.path} (${candidate.source}) could not be run: ${reason(cause)}`);
        continue;
      }

      const outcome = await this.inspect(candidate.path, signal);
      if (outcome.state === "available") return outcome;
      examined.push(`${candidate.path} (${candidate.source}): ${outcome.reason}`);
      // A probe that is there but did not answer is the one case where more time
      // or another path might still tell us something, so it is remembered
      // separately: "I could not look" is not the same finding as "there is none".
      if (outcome.undetermined) undetermined = { reason: outcome.reason, path: candidate.path };
    }

    if (undetermined !== undefined) {
      return { state: "undetermined", reason: undetermined.reason, path: undetermined.path };
    }
    const paths = this.candidates.map((candidate) => candidate.path).join(", ");
    return {
      state: "unavailable",
      reason: examined.join("; "),
      ...(this.candidates.length === 1 ? { path: paths } : {}),
    };
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

    const outcome = await this.invoke(availability.path, request, signal);
    if (typeof outcome === "string") {
      return { kind: "probe-failed", message: outcome, detail: "" };
    }
    if (outcome.aborted) return { kind: "cancelled" };

    const report = parseObject(outcome.stdout);
    if (outcome.timedOut) {
      // The probe was given its own ceiling plus slack and still had to be
      // killed, which is a fact about the probe rather than about the far end.
      return {
        kind: "probe-failed",
        message: `the native probe did not end within ${String(request.totalTimeoutMs + this.killGraceMs)} ms and was killed`,
        detail: firstLine(outcome.stderr),
      };
    }
    if (report !== undefined) {
      if (outcome.exitCode === EXIT_BAD_REQUEST) {
        return { kind: "request-refused", message: refusal(report, outcome) };
      }
      if (outcome.exitCode === EXIT_CANNOT_RUN) {
        return {
          kind: "stack-unavailable",
          state: "unavailable",
          reason: refusal(report, outcome),
          path: availability.path,
        };
      }
      const mapped = this.toReport(report, availability.libraryVersion);
      // A report that arrived but could not be read is version skew between uvp
      // and the probe, not an observation about the target: said as such.
      return typeof mapped === "string"
        ? { kind: "probe-failed", message: mapped, detail: firstLine(outcome.stderr) }
        : { kind: "report", report: mapped };
    }

    if (outcome.stdoutTruncated) {
      return {
        kind: "probe-failed",
        message: `the native probe's report exceeded the ${String(outcome.stdoutBytes)} bytes this call allowed`,
        detail: "",
      };
    }
    return {
      kind: "probe-failed",
      message:
        outcome.exitCode === null
          ? `the native probe was killed by ${String(outcome.signal)} without reporting`
          : `the native probe exited ${String(outcome.exitCode)} without a readable report`,
      detail: firstLine(outcome.stderr),
    };
  }

  /** `--version`, for the availability answer. */
  private async inspect(
    path: string,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly state: "available";
        readonly path: string;
        readonly libraryVersion: string | undefined;
      }
    | { readonly state: "unavailable"; readonly reason: string; readonly undetermined: false }
    | { readonly state: "undetermined"; readonly reason: string; readonly undetermined: true }
  > {
    const outcome = await this.runOrReport({
      command: path,
      args: ["--version"],
      maxOutputBytes: VERSION_BYTES,
      timeoutMs: this.availabilityTimeoutMs,
      signal,
    });
    if (typeof outcome === "string") {
      return { state: "unavailable", reason: outcome, undetermined: false };
    }
    if (outcome.aborted) {
      return {
        state: "undetermined",
        reason: "the availability check was cancelled before the probe answered",
        undetermined: true,
      };
    }
    if (outcome.timedOut) {
      return {
        state: "undetermined",
        reason: `--version did not answer within ${String(this.availabilityTimeoutMs)} ms, so whether this probe works was not established`,
        undetermined: true,
      };
    }
    const report = parseObject(outcome.stdout);
    if (report === undefined || report["probe"] !== PROBE_ID) {
      return {
        state: "unavailable",
        reason: `--version printed no probe report (exit ${String(outcome.exitCode)}): ${firstLine(outcome.stderr) || firstLine(outcome.stdout)}`,
        undetermined: false,
      };
    }
    const libraryVersion = asString(report["library_version"]);
    if (outcome.exitCode !== EXIT_OK) {
      // The probe exits non-zero from `--version` for exactly one reason: the C
      // ABI it was built against is not the one the library reports.
      const built = asNumber(report["header_abi_version"]);
      const loaded = asNumber(report["abi_version"]);
      return {
        state: "unavailable",
        reason:
          built === undefined || loaded === undefined
            ? `--version exited ${String(outcome.exitCode)}`
            : `it was built against C ABI ${String(built)} and the libuvcpp it loads reports ${String(loaded)}; rebuild it against this install`,
        undetermined: false,
      };
    }
    return {
      state: "available",
      path,
      libraryVersion: libraryVersion === "" ? undefined : libraryVersion,
    };
  }

  /** Spawn the probe with one request on stdin. `signal` is passed through. */
  private async invoke(
    path: string,
    request: NativeProbeRequest,
    signal: AbortSignal,
  ): Promise<ProcessOutcome | string> {
    const body = JSON.stringify({
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
    });
    return await this.runOrReport({
      command: path,
      args: [],
      maxOutputBytes: reportBudget(request),
      timeoutMs: request.totalTimeoutMs + this.killGraceMs,
      signal,
      stdin: body,
    });
  }

  /** Run a child, or turn "it would not start" into a sentence. */
  private async runOrReport(options: {
    readonly command: string;
    readonly args: readonly string[];
    readonly maxOutputBytes: number;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly stdin?: string | undefined;
  }): Promise<ProcessOutcome | string> {
    try {
      return await this.run({
        command: options.command,
        args: [...options.args],
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        maxOutputBytes: options.maxOutputBytes,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      });
    } catch (cause) {
      return reason(cause);
    }
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
    if (raw["probe"] !== PROBE_ID) {
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

/** The probe's own explanation of a refusal, or its exit code when it gave none. */
const refusal = (report: RawReport, outcome: ProcessOutcome): string => {
  const error = asObject(report["error"]);
  const what = error === undefined ? undefined : asString(error["what"]);
  if (what !== undefined && what !== "") return what;
  const said = firstLine(outcome.stderr);
  return said === ""
    ? `the native probe refused the request (exit ${String(outcome.exitCode)})`
    : said;
};

/** A short, single-line explanation of an error or an unusual value. */
const reason = (cause: unknown): string => {
  if (cause instanceof Error) {
    const code = (cause as { readonly code?: unknown }).code;
    return typeof code === "string" ? `${cause.message} (${code})` : cause.message;
  }
  return String(cause);
};

/**
 * How many bytes one report may be.
 *
 * Derived from the request rather than fixed: the frame log holds at most
 * `maxFrames` frames, each at most `maxFrameBytes` of payload, and a binary frame
 * arrives base64-encoded with a third again as many bytes. A fixed cap would
 * either cut a large report short or let a small one through unbounded.
 */
const reportBudget = (request: NativeProbeRequest): number =>
  Math.min(
    MAX_REPORT_BYTES,
    Math.max(
      MIN_REPORT_BYTES,
      (request.maxFrames + request.send.length) *
        (Math.ceil((request.maxFrameBytes * 4) / 3) + 512) +
        MIN_REPORT_BYTES,
    ),
  );
