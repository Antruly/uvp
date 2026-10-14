import { describe, expect, it } from "vitest";

import { SessionStore } from "./sessionStore.js";
import type { CaptureSession, ExchangeRecord, SupervisedRun } from "./sessionStore.js";
import type { SupervisedProcess } from "../toolchains/local/processRunner.js";

/**
 * The session store is the only place uvp keeps what it observed, and it is
 * bounded on purpose. Two things must hold: an id that was never recorded is
 * reported as absent rather than answered with an invention, and a bounded view
 * says how much it is hiding instead of presenting itself as the whole truth.
 */

// A clock far from the wall clock, so no test's outcome depends on the day it
// runs. A store that read the real clock would evict all of this as decades old.
const CLOCK_START = "2000-01-01T00:00:00.000Z";
const TTL_MS = 60 * 60 * 1000;
const MAX_EXCHANGES = 5_000;
const MAX_CAPTURES = 16;

const fakeProcess = (): SupervisedProcess => ({
  pid: 4242,
  command: "node server.js",
  // A stub for a service that started: the store never asks, so the promise is
  // resolved rather than absent — the interface has no "not applicable".
  whenStarted: () => Promise.resolve(),
  isRunning: () => true,
  exitInfo: () => undefined,
  stdoutTail: () => "",
  stderrTail: () => "",
  stop: () => Promise.resolve({ outcome: "exited", killed: false }),
  release: () => undefined,
});

const run = (runId: string): SupervisedRun => ({
  runId,
  workspaceId: "ws_1",
  workspacePath: "/tmp/uvp-workspace",
  endpoint: undefined,
  startedAt: CLOCK_START,
  process: fakeProcess(),
});

const exchange = (exchangeId: string, at: string = CLOCK_START): ExchangeRecord => ({
  exchangeId,
  at,
  method: "GET",
  url: "http://127.0.0.1:8080/health",
  status: 200,
  statusText: "OK",
  httpVersion: "1.1",
  requestHeaders: {},
  responseHeaders: {},
  requestBody: undefined,
  responseBody: undefined,
  durationMs: 3,
  truncated: false,
  error: undefined,
  captureId: undefined,
});

const capture = (captureId: string): CaptureSession => ({
  captureId,
  listenPort: 8080,
  upstream: undefined,
  startedAt: CLOCK_START,
  server: { close: () => undefined },
  exchanges: [],
  stopped: false,
});

/** A store whose clock the test moves by hand, so expiry is deterministic. */
const storeAt = (): { store: SessionStore; advance: (ms: number) => string } => {
  let now = new Date(CLOCK_START);
  const store = new SessionStore(() => now);
  return {
    store,
    advance: (ms) => {
      now = new Date(now.getTime() + ms);
      return now.toISOString();
    },
  };
};

describe("runs", () => {
  it("returns the run it registered", () => {
    const { store } = storeAt();
    const registered = run("run_1");
    expect(store.addRun(registered)).toBe(registered);
    expect(store.run("run_1")).toBe(registered);
  });

  it("reports an unknown run id as absent, without throwing", () => {
    const { store } = storeAt();
    expect(store.run("run_missing")).toBeUndefined();
  });

  it("lists runs in the order they were registered, and forgets one on request", () => {
    const { store } = storeAt();
    store.addRun(run("run_1"));
    store.addRun(run("run_2"));
    expect(store.runs().map((entry) => entry.runId)).toEqual(["run_1", "run_2"]);

    store.forgetRun("run_1");
    expect(store.runs().map((entry) => entry.runId)).toEqual(["run_2"]);
    expect(store.run("run_1")).toBeUndefined();
  });
});

describe("recording and reading exchanges", () => {
  it("returns the exchange it recorded, and reads it back by id", () => {
    const { store } = storeAt();
    const recorded = exchange("ex_1");
    expect(store.addExchange(recorded)).toBe(recorded);
    expect(store.exchange("ex_1")).toBe(recorded);
  });

  it("reports an unknown exchange id as absent rather than inventing a record", () => {
    // A caller that asks about an exchange it saw in another session must be told
    // there is nothing here, not handed a plausible-looking placeholder.
    const { store } = storeAt();
    expect(store.exchange("ex_missing")).toBeUndefined();
  });

  it("returns an empty page when nothing has been recorded", () => {
    const { store } = storeAt();
    expect(store.recentExchanges(10)).toEqual([]);
    expect(store.totalExchanges()).toBe(0);
    expect(store.withheldCount()).toBe(0);
  });

  it("returns recent exchanges in the order they were recorded", () => {
    const { store } = storeAt();
    for (const id of ["ex_1", "ex_2", "ex_3"]) store.addExchange(exchange(id));
    expect(store.recentExchanges(10).map((entry) => entry.exchangeId)).toEqual([
      "ex_1",
      "ex_2",
      "ex_3",
    ]);
  });

  it("caps the page at the requested limit without dropping what it left out", () => {
    const { store } = storeAt();
    for (const id of ["ex_1", "ex_2", "ex_3"]) store.addExchange(exchange(id));
    expect(store.recentExchanges(2).map((entry) => entry.exchangeId)).toEqual(["ex_1", "ex_2"]);
    expect(store.totalExchanges()).toBe(3);
    expect(store.exchange("ex_3")).toBeDefined();
  });

  it("starts the page after the id a caller last saw", () => {
    const { store } = storeAt();
    for (const id of ["ex_1", "ex_2", "ex_3"]) store.addExchange(exchange(id));
    expect(store.recentExchanges(10, "ex_1").map((entry) => entry.exchangeId)).toEqual([
      "ex_2",
      "ex_3",
    ]);
  });

  it("counts the exchanges at or before a cursor, so a caller can skip them", () => {
    const { store } = storeAt();
    for (const id of ["ex_1", "ex_2", "ex_3"]) store.addExchange(exchange(id));
    expect(store.exchangesOlderThan("ex_2")).toBe(2);
  });
});

describe("the exchange cap", () => {
  it("keeps the newest and counts what it dropped, so a bounded view is never the whole truth", () => {
    // The cap exists because an unbounded log is a memory leak. `withheld` is the
    // other half of that decision: a caller reading an empty list beside a
    // non-zero count learns there was more, which a silently truncated list hides.
    const { store } = storeAt();
    store.addExchange(exchange("ex_0"));
    for (let index = 1; index <= MAX_EXCHANGES; index += 1) {
      store.addExchange(exchange(`ex_${String(index)}`));
    }

    expect(store.withheldCount()).toBe(1);
    expect(store.totalExchanges()).toBe(MAX_EXCHANGES + 1);
    expect(store.exchange("ex_0")).toBeUndefined();
    // The newest survives: the cap drops from the front of the log, not the back.
    expect(store.exchange(`ex_${String(MAX_EXCHANGES)}`)).toBeDefined();
  });
});

describe("expiry against the injected clock", () => {
  it("keeps an exchange that is still inside the time-to-live", () => {
    const { store, advance } = storeAt();
    store.addExchange(exchange("ex_inside"));
    const at = advance(TTL_MS - 1);
    store.addExchange(exchange("ex_probe", at));
    expect(store.exchange("ex_inside")).toBeDefined();
    expect(store.withheldCount()).toBe(0);
  });

  it("keeps an exchange recorded exactly one time-to-live ago, because the cutoff is inclusive", () => {
    const { store, advance } = storeAt();
    store.addExchange(exchange("ex_edge"));
    const at = advance(TTL_MS);
    store.addExchange(exchange("ex_probe", at));
    expect(store.exchange("ex_edge")).toBeDefined();
    expect(store.withheldCount()).toBe(0);
  });

  it("drops an exchange once the clock has passed its time-to-live, and counts it as withheld", () => {
    const { store, advance } = storeAt();
    store.addExchange(exchange("ex_old"));
    const at = advance(TTL_MS + 1);
    store.addExchange(exchange("ex_probe", at));

    expect(store.exchange("ex_old")).toBeUndefined();
    expect(store.exchange("ex_probe")).toBeDefined();
    expect(store.withheldCount()).toBe(1);
  });

  it("reads the injected clock, never the wall clock", () => {
    // The store's clock sits in 2000. If it consulted the real clock instead,
    // these records would be decades old and evicted on the second add.
    const { store } = storeAt();
    store.addExchange(exchange("ex_a"));
    store.addExchange(exchange("ex_b"));
    expect(store.exchange("ex_a")).toBeDefined();
    expect(store.withheldCount()).toBe(0);
  });

  it("never expires anything while the clock stands still", () => {
    const { store } = storeAt();
    for (let index = 0; index < 50; index += 1) store.addExchange(exchange(`ex_${String(index)}`));
    expect(store.withheldCount()).toBe(0);
    expect(store.exchange("ex_0")).toBeDefined();
  });
});

describe("captures", () => {
  it("returns an empty list when no capture was started", () => {
    const { store } = storeAt();
    expect(store.captures()).toEqual([]);
    expect(store.latestCapture()).toBeUndefined();
  });

  it("reads a capture back by id, and reports an unknown id as absent", () => {
    const { store } = storeAt();
    const registered = capture("cap_1");
    expect(store.addCapture(registered)).toBe(registered);
    expect(store.capture("cap_1")).toBe(registered);
    expect(store.capture("cap_missing")).toBeUndefined();
  });

  it("reports the most recently started capture as the latest", () => {
    const { store } = storeAt();
    store.addCapture(capture("cap_1"));
    store.addCapture(capture("cap_2"));
    expect(store.latestCapture()?.captureId).toBe("cap_2");
  });

  it("evicts the oldest capture beyond the cap", () => {
    const { store } = storeAt();
    for (let index = 0; index <= MAX_CAPTURES; index += 1) {
      store.addCapture(capture(`cap_${String(index)}`));
    }
    expect(store.captures()).toHaveLength(MAX_CAPTURES);
    expect(store.capture("cap_0")).toBeUndefined();
    expect(store.capture(`cap_${String(MAX_CAPTURES)}`)).toBeDefined();
  });
});
