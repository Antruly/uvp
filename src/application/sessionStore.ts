import type { SupervisedProcess } from "./ProcessSupervisor.js";

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
   * The response header names this record actually looked at, when that is
   * narrower than "all of them". `undefined` means the whole set was read.
   *
   * A reader that cannot tell a header the peer did not send from one nobody
   * asked about will report the second as the first — and an assertion on a
   * header name is exactly such a reader. Over HTTP/3 the client reads response
   * headers one name at a time and has no header-list call, so this is a real
   * state rather than a hypothetical one, and it has to travel with the record
   * because by the time an assertion runs the request is long over.
   */
  readonly responseHeadersObserved: readonly string[] | undefined;
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

/**
 * The most exchanges one capture session will hold.
 *
 * A ceiling on the record count, not on their size: it is what bounds a session
 * whose traffic is all tiny — a few thousand empty responses are still a few
 * thousand objects with headers on them. The byte budget below is the bound that
 * matters for the rest, and the two are enforced together.
 */
export const MAX_CAPTURE_EXCHANGES = 5_000;

/**
 * The default budget for the recorded bodies one capture session holds.
 *
 * Bodies are capped per exchange by `maxBodyBytes`, which bounds one record and
 * says nothing about how many of them accumulate: at the 1 MiB default recording
 * limit, an hour of traffic is a process holding gigabytes it never mentions.
 * This is the bound on the total, and it is the caller's to set because the right
 * value depends on what is being captured — a page of JSON and a page of images
 * are not the same session.
 */
export const DEFAULT_RETAINED_BYTES = 32 * 1024 * 1024;

/**
 * What a capture session holds, and what it has dropped to stay inside its caps.
 *
 * `exchanges` is bounded and holds the most recent ones; `recorded` counts every
 * exchange the session saw, held or not, so a read can say "there was more"
 * rather than presenting the window as the whole truth. `bytes` is the recorded
 * body bytes currently held, which is what the byte budget is spent on.
 */
export interface CaptureRetention {
  readonly exchanges: ExchangeRecord[];
  /** Recorded by this session, held or not. */
  recorded: number;
  /** Recorded and no longer held, because a cap dropped it. */
  withheld: number;
  /** Recorded body bytes currently held, either direction. */
  bytes: number;
  /** The byte budget `bytes` is kept within, as the caller set it. */
  readonly byteBudget: number;
}

export const createCaptureRetention = (byteBudget: number): CaptureRetention => ({
  exchanges: [],
  recorded: 0,
  withheld: 0,
  bytes: 0,
  byteBudget,
});

/** The bytes of an exchange that count against the budget: the bodies kept. */
const retainedBytesOf = (record: ExchangeRecord): number =>
  (record.requestBody?.byteLength ?? 0) + (record.responseBody?.byteLength ?? 0);

/**
 * Keep one exchange, dropping the oldest until both caps are met.
 *
 * The oldest are dropped rather than the newest, because a capture is read to
 * find out what just happened.
 *
 * One record is always kept, even when it alone exceeds the byte budget — a
 * caller who sets a budget below `maxBodyBytes` would otherwise capture nothing
 * and be told only that something was dropped. That keeps the budget from being
 * a hard bound on one record, which is why `retained_bytes` is reported beside
 * it: the caller can see the exception rather than assume it away.
 */
export const retainCaptureExchange = (
  retention: CaptureRetention,
  record: ExchangeRecord,
): ExchangeRecord => {
  retention.exchanges.push(record);
  retention.recorded += 1;
  retention.bytes += retainedBytesOf(record);
  while (
    retention.exchanges.length > MAX_CAPTURE_EXCHANGES ||
    (retention.bytes > retention.byteBudget && retention.exchanges.length > 1)
  ) {
    const evicted = retention.exchanges.shift();
    if (evicted === undefined) break;
    retention.bytes -= retainedBytesOf(evicted);
    retention.withheld += 1;
  }
  return record;
};

export interface CaptureSession {
  readonly captureId: string;
  readonly listenPort: number;
  readonly upstream: string | undefined;
  readonly startedAt: string;
  /** The most bytes kept per direction for this session, as the caller set it. */
  readonly maxBodyBytes: number;
  /** The budget for the bodies this session holds in total. */
  readonly maxRetainedBytes: number;
  readonly server: { close: (callback?: () => void) => void };
  readonly retention: CaptureRetention;
  stopped: boolean;
}

/**
 * The most exchanges the session-wide store keeps, across every capture.
 *
 * Distinct from `MAX_CAPTURE_EXCHANGES`, which bounds one capture session's own
 * list: this one bounds the flat log that evidence references and
 * `uvp_assert_exchange` read from.
 */
const MAX_STORED_EXCHANGES = 5_000;
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
      const evicted = this.#captures.get(oldest.value);
      this.#captures.delete(oldest.value);
      // Eviction drops the only handle a caller has on this proxy. Closing it is
      // what makes that a release rather than a leak: the id is gone from the
      // store, so `capture_read` and `capture stop` answer `capture_unavailable`
      // while the listener would otherwise keep accepting and forwarding. A
      // session already stopped was closed by its own path and is not closed
      // twice.
      if (evicted !== undefined && !evicted.stopped) {
        evicted.stopped = true;
        evicted.server.close();
      }
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
    while (this.#exchangeOrder.length > MAX_STORED_EXCHANGES) {
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
