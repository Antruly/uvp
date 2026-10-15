import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";

import { runProcess } from "../processRunner.js";
import type { ProcessOutcome, RunProcessOptions } from "../processRunner.js";
import type { NativeProbeAvailability } from "../../application/nativeProbe.js";

/**
 * One of uvp's native probes, as a supervised child process.
 *
 * `native/uvcpp-probe` is a small C++ program that links libuvcpp's C ABI, reads
 * one JSON request on stdin, and writes one JSON report on stdout. It answers two
 * exchanges — WebSocket and HTTP/3 — and this class is everything those two have
 * in common about *reaching* it: where the binary is, whether it works, running it
 * with a bounded budget, and reading the envelope of its report. The exchange's
 * own request and report shapes are the subclass's, and so is every judgement
 * about what its facts mean, which belongs to the service layer.
 *
 * Three properties the C++ side establishes, and which the code below depends on
 * rather than re-deriving:
 *
 *   - The report is written to stdout as exactly one JSON object, on every exit
 *     path including the refusals. So a refusal is *read*, not guessed at from an
 *     exit code alone.
 *   - Exit 2 is "the request is wrong", exit 3 is "this probe cannot run here". A
 *     run that the probe's own watchdog ended is still an exit 0 with a report.
 *   - The probe bounds itself. It writes the report at its deadline and ends the
 *     process, because the C ABI's client loops cannot be woken from another
 *     thread. The supervisor's timeout below is therefore a backstop for a probe
 *     that failed to do that, and hitting it means the run is *unknown*, not that
 *     the target was slow.
 *
 * The binary is not vendored and not built on demand: building it needs a C++
 * toolchain and a libuvcpp built with `UVCPP_ENABLE_CAPI=ON`, and a probe call that
 * silently started a five-minute compile would be a tool call nobody can bound.
 * `npm run build:native-probe` builds it, `UVP_NATIVE_PROBE` points at a build
 * somewhere else, and a host with neither is reported as unavailable.
 *
 * The search order for a probe binary lives here and only here. Two exchanges that
 * each knew where to look would be two answers to "which probe am I running", and
 * the second one would be found by a caller debugging the first.
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
 * The probe's ceiling is `total_timeout_ms`; this is the slack for the process to
 * write its report and exit. Anything beyond it means the probe did not end as it
 * promises to, so the run is reported as failed rather than as a result.
 */
const DEFAULT_KILL_GRACE_MS = 3_000;

/** The floor for a report's byte budget, so a tiny probe still fits its own JSON. */
export const REPORT_BYTES_FLOOR = 64 * 1024;

/** A ceiling as well as a floor: the caller's numbers are not a licence. */
const REPORT_BYTES_CEILING = 32 * 1024 * 1024;

/** `--version` output is one small object; anything larger is not this probe. */
const VERSION_BYTES = 8 * 1024;

type RunProcess = (options: RunProcessOptions) => Promise<ProcessOutcome>;

export interface NativeProbeProcessOptions {
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

/** The JSON a report is, as far as this layer reads it. */
export type RawReport = Record<string, unknown>;

export const asObject = (value: unknown): RawReport | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawReport)
    : undefined;

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/** The first JSON object in `text`, or nothing: a probe writes exactly one. */
export const parseObject = (text: string): RawReport | undefined => {
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
 * report that arrived is preferred over it, so this is only used when there is no
 * report to quote.
 */
export const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/** A short, single-line explanation of an error or an unusual value. */
export const reason = (cause: unknown): string => {
  if (cause instanceof Error) {
    const code = (cause as { readonly code?: unknown }).code;
    return typeof code === "string" ? `${cause.message} (${code})` : cause.message;
  }
  return String(cause);
};

/**
 * The probe's own explanation of a refusal, or its exit code when it gave none.
 */
export const refusal = (report: RawReport, outcome: ProcessOutcome): string => {
  const error = asObject(report["error"]);
  const what = error === undefined ? undefined : asString(error["what"]);
  if (what !== undefined && what !== "") return what;
  const said = firstLine(outcome.stderr);
  return said === ""
    ? `the native probe refused the request (exit ${String(outcome.exitCode)})`
    : said;
};

/** What one exchange tells the shared plumbing about itself. */
export interface ProbeExchange {
  /**
   * The exchange's name, as `native/uvcpp-probe` spells it in `exchange`.
   *
   * Sent with every request so one binary can serve both.
   */
  readonly name: string;
  /**
   * Whether a probe build must list this exchange in `--version` before it is
   * usable.
   *
   * True for HTTP/3, which arrived with the exchange list, so a probe that does
   * not list it is definitely one that cannot run it. False for WebSocket, which
   * predates the list and was the only exchange then: an older probe answers
   * `--version` without the field and still speaks WebSocket perfectly well, so
   * requiring the field would refuse a binary that works.
   */
  readonly listedInVersion: boolean;
}

/** The availability of one probe binary, with what `--version` said about it. */
interface Inspected {
  readonly state: "available";
  readonly path: string;
  readonly libraryVersion: string | undefined;
}

type InspectResult =
  | Inspected
  | { readonly state: "unavailable"; readonly reason: string; readonly undetermined: false }
  | { readonly state: "undetermined"; readonly reason: string; readonly undetermined: true };

export abstract class NativeProbeProcess {
  private readonly candidates: readonly Candidate[];
  private readonly availabilityTimeoutMs: number;
  private readonly run: RunProcess;
  protected readonly killGraceMs: number;
  private readonly exchange: ProbeExchange;

  constructor(exchange: ProbeExchange, options: NativeProbeProcessOptions = {}) {
    const env = options.env ?? process.env;
    const moduleDirectory = options.moduleDirectory ?? import.meta.dirname;
    // A caller who named a binary gets that binary or a report of why not. Falling
    // back to another one would mean `UVP_NATIVE_PROBE` could be set to something
    // wrong and the tool would quietly probe with something else.
    const named = env["UVP_NATIVE_PROBE"];
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
    this.exchange = exchange;
  }

  /**
   * Whether the stack can be used here.
   *
   * Two questions, in order, because they fail differently: is there a file to
   * run, and does what is there work. `--version` is the second — the probe
   * answers it by reporting the C ABI it was built against, the library it loaded,
   * and the exchanges it has, and refuses (exit 3) when the first two disagree.
   * That mismatch is the failure mode with no useful symptom, so it is checked
   * before anything connects to anything.
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
   * Run the probe with one exchange request on stdin.
   *
   * The envelope is this layer's; the request body is the subclass's. Returned as
   * the raw outcome rather than a mapped report because the subclass owns every
   * judgement about the report — including which of the exit codes means a refusal
   * of *its* request.
   */
  protected async invoke(
    path: string,
    request: unknown,
    signal: AbortSignal,
    totalTimeoutMs: number,
    maxOutputBytes: number,
  ): Promise<ProcessOutcome | string> {
    return await this.runOrReport({
      command: path,
      args: [],
      maxOutputBytes,
      timeoutMs: totalTimeoutMs + this.killGraceMs,
      signal,
      stdin: JSON.stringify({ exchange: this.exchange.name, ...(request as object) }),
    });
  }

  /** The message for a probe that was given its budget and still had to be killed. */
  protected timedOutMessage(totalTimeoutMs: number): string {
    return `the native probe did not end within ${String(totalTimeoutMs + this.killGraceMs)} ms and was killed`;
  }

  /**
   * One report's JSON object, or the sentence saying what arrived instead.
   *
   * `detail` is what the probe managed to say on stderr, and it is empty when the
   * probe said nothing worth quoting — which is the truncated case, where the
   * message already names the bound that was hit and stderr would be a fragment of
   * the report that was cut off.
   */
  protected readEnvelope(
    outcome: ProcessOutcome,
  ):
    | { readonly kind: "report"; readonly raw: RawReport }
    | { readonly kind: "request-refused"; readonly message: string }
    | { readonly kind: "cannot-run"; readonly message: string }
    | { readonly kind: "unreadable"; readonly message: string; readonly detail: string } {
    const report = parseObject(outcome.stdout);
    if (report === undefined) {
      if (outcome.stdoutTruncated) {
        return {
          kind: "unreadable",
          message: `the native probe's report exceeded the ${String(outcome.stdoutBytes)} bytes this call allowed`,
          detail: "",
        };
      }
      return {
        kind: "unreadable",
        message:
          outcome.exitCode === null
            ? `the native probe was killed by ${String(outcome.signal)} without reporting`
            : `the native probe exited ${String(outcome.exitCode)} without a readable report`,
        detail: firstLine(outcome.stderr),
      };
    }
    if (outcome.exitCode === EXIT_BAD_REQUEST) {
      return { kind: "request-refused", message: refusal(report, outcome) };
    }
    if (outcome.exitCode === EXIT_CANNOT_RUN) {
      return { kind: "cannot-run", message: refusal(report, outcome) };
    }
    return { kind: "report", raw: report };
  }

  /** The probe's identity check, or nothing when the report is not this probe's. */
  protected isProbeReport(raw: RawReport): boolean {
    return raw["probe"] === PROBE_ID;
  }

  /** `--version`, for the availability answer. */
  private async inspect(path: string, signal: AbortSignal): Promise<InspectResult> {
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
    if (report === undefined || !this.isProbeReport(report)) {
      return {
        state: "unavailable",
        reason: `--version printed no probe report (exit ${String(outcome.exitCode)}): ${firstLine(outcome.stderr) || firstLine(outcome.stdout)}`,
        undetermined: false,
      };
    }
    const libraryVersion = asString(report["library_version"]);
    if (outcome.exitCode !== EXIT_OK) {
      // The probe exits non-zero from `--version` for exactly one reason: the C ABI
      // it was built against is not the one the library reports.
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
    const unsupported = this.unsupportedExchange(report);
    if (unsupported !== undefined) {
      return { state: "unavailable", reason: unsupported, undetermined: false };
    }
    return {
      state: "available",
      path,
      libraryVersion: libraryVersion === "" ? undefined : libraryVersion,
    };
  }

  /**
   * Why this probe build cannot run this exchange, or nothing when it can.
   *
   * A `--version` that answered is a build that works; this is the narrower
   * question of whether it has *this* exchange. It is a definite finding rather
   * than an undetermined one: the probe answered the question about itself and the
   * answer was no, which is a different thing from not having asked.
   */
  private unsupportedExchange(report: RawReport): string | undefined {
    if (!this.exchange.listedInVersion) return undefined;
    const listed = report["exchanges"];
    const names = Array.isArray(listed)
      ? listed.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (names.includes(this.exchange.name)) return undefined;
    // The probe's own account of why it lacks the exchange comes first, because the
    // remedy differs. `npm run build:native-probe` is the wrong instruction when what
    // is missing is in the libuvcpp install — repeating the build produces the same
    // binary — and only the build that produced this one knows which of the two it
    // was, since it asked the compiler. The generic sentence below is what is left
    // for a probe that reports its exchange list and no reason.
    const ownReason = this.exchangeReason(report);
    if (ownReason !== undefined) return ownReason;
    return names.length === 0
      ? `it was built before the ${this.exchange.name} exchange existed and does not report which exchanges it has; rebuild it with \`npm run build:native-probe\``
      : `it can run ${names.join(", ")} but not ${this.exchange.name}; rebuild it with \`npm run build:native-probe\``;
  }

  /**
   * What `--version` said about why this exchange is not in the build, if anything.
   *
   * `unavailable_exchanges` is keyed by exchange name, and the field is written even
   * when it is empty, so its presence and its content are two different answers: an
   * absent field is a probe too old to be asked, and an empty object is a probe that
   * has nothing missing. Only the second of those is read here as "no reason given".
   */
  private exchangeReason(report: RawReport): string | undefined {
    const reasons = asObject(report["unavailable_exchanges"]);
    if (reasons === undefined) return undefined;
    const said = asString(reasons[this.exchange.name]);
    return said === undefined || said === "" ? undefined : said;
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
}

/**
 * How many bytes one report may be, given how many bytes its payload can hold.
 *
 * Derived from the request rather than fixed, because a fixed cap would either cut
 * a large report short or let a small one through unbounded. What each exchange
 * passes is its own payload arithmetic — a frame log's frames, a response body's
 * bytes — plus room for the JSON around them; the clamp is the part they share, and
 * it is here because a second copy of it would be a second ceiling.
 */
export const reportBudgetFor = (payloadBytes: number): number =>
  Math.min(REPORT_BYTES_CEILING, Math.max(REPORT_BYTES_FLOOR, payloadBytes + REPORT_BYTES_FLOOR));
