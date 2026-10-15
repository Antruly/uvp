import type { SupervisedProcess } from "../toolchains/local/processRunner.js";

/**
 * Session-scoped state.
 *
 * Everything uvp observes lives and dies with the session that observed it.
 * There is no on-disk cache of exchanges or runs: reconnecting to a different
 * process must not resurrect a handle to a service that no longer exists, and
 * an evidence reference is only meaningful inside the session that minted it.
 *
 * The store is bounded on purpose. An unbounded exchange log turns a
 * long-running debugging session into a memory leak, and a caller reading
 * `withheld` learns more than a caller reading a truncated list.
 */

export interface SupervisedRun {
  readonly runId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly endpoint: string | undefined;
  readonly startedAt: string;
  readonly process: SupervisedProcess;
}

export interface ExchangeRecord {
  readonly exchangeId: string;
  readonly at: string;
  readonly method: string;
  readonly url: string;
  readonly status: number | undefined;
  readonly statusText: string | undefined;
  readonly httpVersion: string | undefined;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly responseHeaders: Readonly<Record<string, string>>;
  /**
   * The bytes recorded, each capped by the session's `maxBodyBytes`.
   *
   * The flags are per direction because the two are capped by different things:
   * a request body is capped by this module while recording, and a response body
   * by the transport's own read limit as well. A single `truncated` said that one
   * of the two had been cut without saying which, and a caller reading a request
   * volume from a truncated body would be reading a number about the wrong side.
   */
  readonly requestBody: Buffer | undefined;
  readonly responseBody: Buffer | undefined;
  readonly requestBodyTruncated: boolean;
  readonly responseBodyTruncated: boolean;
  readonly durationMs: number;
  readonly error: string | undefined;
  readonly captureId: string | undefined;
}

export interface CaptureSession {
  readonly captureId: string;
  readonly listenPort: number;
  readonly upstream: string | undefined;
  readonly startedAt: string;
  /** The most bytes kept per direction for this session, as the caller set it. */
  readonly maxBodyBytes: number;
  readonly server: { close: (callback?: () => void) => void };
  readonly exchanges: ExchangeRecord[];
  stopped: boolean;
}

const MAX_EXCHANGES = 5_000;
const MAX_CAPTURES = 16;
const EXCHANGE_TTL_MS = 60 * 60 * 1000;

export class SessionStore {
  readonly #runs = new Map<string, SupervisedRun>();
  readonly #exchanges = new Map<string, ExchangeRecord>();
  readonly #exchangeOrder: string[] = [];
  readonly #captures = new Map<string, CaptureSession>();
  #withheld = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Register a run and return the record that was stored. */
  addRun(run: SupervisedRun): SupervisedRun {
    this.#runs.set(run.runId, run);
    return run;
  }

  run(runId: string): SupervisedRun | undefined {
    return this.#runs.get(runId);
  }

  runs(): readonly SupervisedRun[] {
    return [...this.#runs.values()];
  }

  forgetRun(runId: string): void {
    this.#runs.delete(runId);
  }

  /**
   * Record an exchange, evicting the oldest beyond the cap.
   *
   * `withheld` counts what the cap dropped, so `uvp_capture_read` can report
   * "there was more" instead of presenting a bounded view as the whole truth.
   */
  addExchange(record: ExchangeRecord): ExchangeRecord {
    this.#exchanges.set(record.exchangeId, record);
    this.#exchangeOrder.push(record.exchangeId);
    this.#pruneExchanges();
    return record;
  }

  exchange(exchangeId: string): ExchangeRecord | undefined {
    return this.#exchanges.get(exchangeId);
  }

  recentExchanges(limit: number, sinceId?: string): readonly ExchangeRecord[] {
    const ordered = [...this.#exchangeOrder];
    const start = sinceId === undefined ? 0 : Math.max(0, ordered.indexOf(sinceId) + 1);
    const slice = ordered.slice(start, start + limit);
    return slice
      .map((id) => this.#exchanges.get(id))
      .filter((record): record is ExchangeRecord => record !== undefined);
  }

  exchangesOlderThan(sinceId: string): number {
    const index = this.#exchangeOrder.indexOf(sinceId);
    return index < 0 ? 0 : index + 1;
  }

  withheldCount(): number {
    return this.#withheld;
  }

  totalExchanges(): number {
    return this.#exchangeOrder.length + this.#withheld;
  }

  addCapture(session: CaptureSession): CaptureSession {
    this.#captures.set(session.captureId, session);
    while (this.#captures.size > MAX_CAPTURES) {
      const oldest = this.#captures.keys().next();
      if (oldest.done === true) break;
      this.#captures.delete(oldest.value);
    }
    return session;
  }

  capture(captureId: string): CaptureSession | undefined {
    return this.#captures.get(captureId);
  }

  latestCapture(): CaptureSession | undefined {
    let latest: CaptureSession | undefined;
    for (const session of this.#captures.values()) latest = session;
    return latest;
  }

  captures(): readonly CaptureSession[] {
    return [...this.#captures.values()];
  }

  #pruneExchanges(): void {
    const cutoff = this.now().getTime() - EXCHANGE_TTL_MS;
    while (this.#exchangeOrder.length > MAX_EXCHANGES) {
      const evicted = this.#exchangeOrder.shift();
      if (evicted === undefined) break;
      this.#exchanges.delete(evicted);
      this.#withheld += 1;
    }
    // Expire by age as well as by count: a session that goes quiet for an hour
    // should not keep paying for exchanges nobody will read.
    let expired = 0;
    for (const [id, record] of this.#exchanges) {
      if (Date.parse(record.at) >= cutoff) continue;
      this.#exchanges.delete(id);
      const index = this.#exchangeOrder.indexOf(id);
      if (index >= 0) this.#exchangeOrder.splice(index, 1);
      expired += 1;
    }
    if (expired > 0) this.#withheld += expired;
  }
}
