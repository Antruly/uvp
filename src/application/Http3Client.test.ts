import { describe, expect, it } from "vitest";

import { SessionStore } from "./sessionStore.js";
import { createRecorder } from "./evidenceHelpers.js";
import { Http3Client, type Http3RequestInput } from "./Http3Client.js";
import type {
  NativeHttp3Outcome,
  NativeHttp3Probe,
  NativeHttp3Report,
} from "./NativeHttp3Probe.js";
import { toUvpError, UvpFailure, type UvpError } from "../domain/errors.js";

/**
 * `uvp_http_request` over HTTP/3, driven through an injected probe.
 *
 * The claim here is narrow and deliberate: given a report, uvp says the right
 * thing — and given a request this stack cannot serve, it says so *before* a
 * probe process exists. What it does not establish is that libuvcpp's h3 client
 * and a generated h3 service agree about anything, which is
 * `tests/toolchain/nativeProbe.test.ts`'s subject and needs a real compiler.
 *
 * The refusals come first because they are the ones that would otherwise become
 * green results about a transport nobody used. Each is asserted to happen with
 * the probe never asked, and the fake probe here records being asked — a refusal
 * that ran *after* a probe would still satisfy a test that only checked the code
 * it threw.
 */

/** A report carrying the facts of one successful exchange. */
const answeredReport = (overrides: Partial<NativeHttp3Report> = {}): NativeHttp3Report => ({
  url: "https://127.0.0.1:8095/hello",
  host: "127.0.0.1",
  port: 8095,
  method: "GET",
  path: "/hello",
  authority: "127.0.0.1:8095",
  verifyPeer: false,
  handshakeCompleted: true,
  handshakeOk: true,
  handshakeStatus: 0,
  alpn: "h3",
  requestSent: true,
  streamId: 0,
  sendAttempts: 1,
  lastSendError: undefined,
  answered: true,
  status: 200,
  responseError: 0,
  headers: {
    "content-type": "text/plain; charset=utf-8",
    date: "Thu, 16 Oct 2026 00:00:00 GMT",
  },
  headersObserved: ["content-type", "date"],
  body: "hello over HTTP/3",
  bodyBytes: 17,
  bodyOmitted: undefined,
  bytesIn: 210,
  bytesOut: 90,
  disconnected: false,
  error: undefined,
  stopReason: "answered",
  abandoned: false,
  totalMs: 23,
  notObservable: ["the response headers outside the reported list"],
  libraryVersion: "1.7.0",
  ...overrides,
});

/**
 * A probe that ends every run the same way, and remembers whether it was asked.
 *
 * `asked` is the half that matters: three of the tests below are about a refusal
 * that must arrive *before* this is reached, and a probe that only ever answers
 * could not tell a refusal that ran first from one that ran afterwards.
 */
const answering = (outcome: NativeHttp3Outcome): { asked: string[]; probe: NativeHttp3Probe } => {
  const asked: string[] = [];
  return {
    asked,
    probe: {
      availability: async () => ({
        state: "available",
        path: "/tmp/uvcpp-probe",
        libraryVersion: "1.7.0",
      }),
      probe: async (request) => {
        asked.push(request.url);
        return outcome;
      },
    },
  };
};

const NOW = (): Date => new Date("2026-10-16T00:00:00.000Z");

const input = (overrides: Partial<Http3RequestInput> = {}): Http3RequestInput => ({
  url: "https://127.0.0.1:8095/hello",
  method: "GET",
  headers: {},
  body: undefined,
  body_encoding: "utf8",
  follow_redirects: false,
  // Off, because the QUIC client verifies only against a CA bundle it is handed
  // and this tool has no input for one — see the refusal test below.
  verify_tls: false,
  timeout_ms: 5_000,
  max_body_bytes: 65_536,
  ...overrides,
});

/** Run one request against a fresh session, and hand back everything it left. */
const send = async (client: NativeHttp3Probe, overrides: Partial<Http3RequestInput> = {}) => {
  const store = new SessionStore(NOW);
  const recorder = createRecorder(NOW);
  const output = await new Http3Client(client, store, NOW, recorder).request(
    input(overrides),
    new AbortController().signal,
  );
  return { output, store, recorder, exchanges: store.recentExchanges(20) };
};

/**
 * The failure a call threw, projected into the error contract.
 *
 * The `instanceof` check before the projection is load-bearing rather than
 * defensive. `toUvpError` maps an unrecognised throw to `execution_failure`, so
 * a call that threw a plain `Error` — or a `TypeError` from this file's own
 * plumbing — would arrive at the assertions below looking exactly like the
 * `probe-failed` case they are meant to distinguish.
 */
const failureOf = async (run: () => Promise<unknown>): Promise<UvpError> => {
  try {
    await run();
  } catch (cause) {
    if (!(cause instanceof UvpFailure)) {
      throw new Error(`expected a UvpFailure, got ${String(cause)}`);
    }
    return toUvpError(cause);
  }
  throw new Error("expected a failure and the call returned");
};

describe("what HTTP/3 refuses before anything is spawned", () => {
  it("refuses http://, because QUIC has no cleartext mode", async () => {
    const { asked, probe } = answering({ kind: "report", report: answeredReport() });
    const failure = await failureOf(() => send(probe, { url: "http://127.0.0.1:8095/hello" }));
    expect(failure.code).toBe("invalid_request");
    expect(failure.message).toContain("https://");
    expect(asked).toEqual([]);
  });

  it("refuses verify_tls, naming the flag that gets through", async () => {
    // The default is on, so this is the refusal most callers meet first. It is
    // not a limitation to route around: the C ABI's QUIC client verifies against
    // a CA bundle it is handed or not at all, so `verified` is a claim this path
    // cannot make — and a result that reported it would be reporting a chain
    // nobody examined.
    const { asked, probe } = answering({ kind: "report", report: answeredReport() });
    const failure = await failureOf(() => send(probe, { verify_tls: true }));
    expect(failure.code).toBe("unsupported_target");
    expect(failure.remediation.action).toContain("--no-tls");
    expect(failure.remediation.action).toContain("not_checked");
    expect(asked).toEqual([]);
  });

  it("refuses follow_redirects, because the probe makes one request", async () => {
    // Following a hop would mean a second connection and a chain assembled from
    // evidence in two processes. Answering with the first hop's 3xx as though it
    // were the end of the chain is the failure this refusal exists to prevent.
    const { asked, probe } = answering({ kind: "report", report: answeredReport() });
    const failure = await failureOf(() => send(probe, { follow_redirects: true }));
    expect(failure.code).toBe("invalid_request");
    expect(failure.remediation.action).toContain("follow_redirects: false");
    expect(asked).toEqual([]);
  });

  it("refuses a URL that is not absolute before it asks anything", async () => {
    const { asked, probe } = answering({ kind: "report", report: answeredReport() });
    await expect(send(probe, { url: "/hello" })).rejects.toThrow();
    expect(asked).toEqual([]);
  });
});

describe("a report that answered", () => {
  it("reports the exchange, and records it for a later assertion", async () => {
    const { probe } = answering({ kind: "report", report: answeredReport() });
    const { output, exchanges } = await send(probe);

    expect(output.status).toBe(200);
    expect(output.http_version).toBe("3");
    expect(output.request_http_version).toBe("3");
    // Empty rather than invented: HTTP/3 dropped the reason phrase, so a
    // synthesised "OK" would be a string this stack never sent.
    expect(output.status_text).toBe("");
    expect(output.body.text).toBe("hello over HTTP/3");
    expect(output.body.bytes).toBe(17);
    expect(output.body.truncated).toBe(false);
    // Always empty, and not because nothing redirected: `follow_redirects: true`
    // was refused, so a 3xx is the answer and its Location is in `headers`.
    expect(output.redirects).toEqual([]);
    expect(output.headers["content-type"]).toBe("text/plain; charset=utf-8");

    // The recording, which is what makes the exchange re-checkable at all.
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.exchangeId).toBe(output.exchange_id);
    expect(exchanges[0]?.status).toBe(200);
    expect(exchanges[0]?.responseBody?.toString("utf8")).toBe("hello over HTTP/3");
  });

  it("carries the header names that were read, so a later assertion can tell", async () => {
    // The field that makes the recorded exchange honest, and the reason this
    // path and the Node path share a record type. Without it, a header assertion
    // on this exchange would report a name the client never asked about as
    // absent — a finding about the service derived from a gap in the client.
    // What an assertion then says is `assertions.test.ts`'s subject; this is the
    // half that gets it there.
    const { probe } = answering({ kind: "report", report: answeredReport() });
    const { exchanges } = await send(probe);
    expect(exchanges[0]?.responseHeadersObserved).toEqual(["content-type", "date"]);
  });

  it("reports only the whole-call duration, with no phase to read", async () => {
    // The probe polls the h3 connection every 2 ms because the stack has no
    // ready callback, so a "DNS time" measured on top of that would be a number
    // about the poll interval wearing the name of a phase. Absent, not zero.
    const { probe } = answering({ kind: "report", report: answeredReport() });
    const { output } = await send(probe);
    expect(output.timing).toEqual({ total_ms: 23 });
  });

  it("reports a body over the cap as omitted, with the real byte count", async () => {
    const { probe } = answering({
      kind: "report",
      report: answeredReport({ body: "", bodyBytes: 900_000, bodyOmitted: "over max_body_bytes" }),
    });
    const { output, exchanges } = await send(probe);
    // `truncated: true` is the only claim available: this stack has no partial
    // read, so the body is whole or absent — and this one is absent, which is
    // why the text is empty while `bytes` is the size the peer actually sent.
    expect(output.body.truncated).toBe(true);
    expect(output.body.bytes).toBe(900_000);
    expect(output.body.text).toBe("");
    expect(exchanges[0]?.responseBodyTruncated).toBe(true);
  });

  it("states the partial header coverage rather than implying a full set", async () => {
    const { probe } = answering({ kind: "report", report: answeredReport() });
    const { recorder } = await send(probe);
    const evidence = recorder.evidence[0];
    expect(evidence?.coverage.status).toBe("partial");
    expect(evidence?.coverage.note).toContain("content-type");
    // And in the limitations, which travel with the evidence ref — the same
    // sentence the probe lane reads out of the CLI's JSON. It names `headers`,
    // the output field a caller has, rather than the evidence's own
    // `headers_observed`: an evidence ref is projected without its `derived` map,
    // so a limitation that pointed at that key would be pointing at nothing a
    // reader could open.
    expect((evidence?.limitations ?? []).join(" ")).toContain("listed in `headers`");
  });

  it("names the ALPN, and says no certificate was examined", async () => {
    const { probe } = answering({ kind: "report", report: answeredReport() });
    const { output } = await send(probe);
    expect(output.tls?.verification).toBe("not_checked");
    expect(output.tls?.reason).toContain("ALPN h3");
    // Nothing about a certificate, because nothing was read: a `subject` here
    // would be a value nobody observed.
    expect(output.tls?.subject).toBeUndefined();
    expect(output.tls?.protocol).toBeUndefined();
  });
});

describe("a report that did not answer", () => {
  it("reports the caller's own deadline as a timeout, not as a dead service", async () => {
    const { probe } = answering({
      kind: "report",
      report: answeredReport({
        answered: false,
        status: undefined,
        stopReason: "total",
        totalMs: 5_000,
        requestSent: false,
        streamId: undefined,
        handshakeCompleted: false,
        handshakeOk: false,
      }),
    });
    const failure = await failureOf(() => send(probe));
    expect(failure.code).toBe("timeout");
    expect(failure.message).toContain("5000 ms");
    expect(failure.details?.["elapsed_ms"]).toBe(5_000);
  });

  it("reports a name that did not resolve as a fact about the target", async () => {
    // The probe reports a synchronous connect rejection rather than refusing it,
    // so this arrives as a target that never handshook, carrying the library's
    // own words and code.
    const { probe } = answering({
      kind: "report",
      report: answeredReport({
        answered: false,
        status: undefined,
        stopReason: undefined,
        handshakeCompleted: false,
        handshakeOk: false,
        handshakeStatus: -3008,
        alpn: "",
        requestSent: false,
        streamId: undefined,
        error: { what: "unknown node or service", code: -3008 },
      }),
    });
    const failure = await failureOf(() => send(probe));
    expect(failure.code).toBe("target_unavailable");
    expect(failure.message).toContain("unknown node or service");
    expect(failure.details?.["reason_code"]).toBe(-3008);
  });

  it("reports a handshake that completed and then answered nothing differently", async () => {
    // The two findings point in opposite directions — "nothing is listening" and
    // "it took the request and said nothing" — so they are two codes with two
    // remedies, not one.
    const { probe } = answering({
      kind: "report",
      report: answeredReport({
        answered: false,
        status: undefined,
        stopReason: "idle",
        requestSent: true,
      }),
    });
    const failure = await failureOf(() => send(probe));
    expect(failure.code).toBe("endpoint_unreachable");
    expect(failure.remediation.action).toContain("route");
  });
});

describe("what the probe itself reports", () => {
  it("keeps the probe's own refusal as an invalid request, with the probe's words", async () => {
    const { probe } = answering({ kind: "request-refused", message: "port must be 1-65535" });
    const failure = await failureOf(() => send(probe));
    expect(failure.code).toBe("invalid_request");
    expect(failure.message).toContain("port must be 1-65535");
  });

  it("keeps a stack that cannot run and a stack that could not be checked apart", async () => {
    const unavailable = await failureOf(() =>
      send(
        answering({
          kind: "stack-unavailable",
          state: "unavailable",
          reason: "no probe binary",
          path: "/tmp/uvcpp-probe",
        }).probe,
      ),
    );
    expect(unavailable.code).toBe("toolchain_unavailable");
    expect(unavailable.message).toContain("cannot make HTTP/3 requests");
    expect(unavailable.message).toContain("no probe binary");

    const undetermined = await failureOf(() =>
      send(
        answering({
          kind: "stack-unavailable",
          state: "undetermined",
          reason: "the probe answered nothing",
          path: "/tmp/uvcpp-probe",
        }).probe,
      ),
    );
    // Neither "you have no probe" about a probe that exists nor a pass about one
    // that never answered: the third state travels as itself, in the words and
    // in the details.
    expect(undetermined.code).toBe("toolchain_unavailable");
    expect(undetermined.message).toContain("could not be determined");
    expect(undetermined.details?.["state"]).toBe("undetermined");
  });

  it("reports a probe that produced no report as an execution failure", async () => {
    const { probe } = answering({ kind: "probe-failed", message: "exit 3", detail: "no QUIC" });
    const failure = await failureOf(() => send(probe));
    expect(failure.code).toBe("execution_failure");
    expect(failure.message).toContain("produced no report");
    expect(failure.details?.["probe_said"]).toBe("no QUIC");
  });

  it("reports a cancelled run as cancelled, not as a failure of the target", async () => {
    const { probe } = answering({ kind: "cancelled" });
    const failure = await failureOf(() => send(probe));
    expect(failure.code).toBe("cancelled");
  });
});

describe("the request the probe is handed", () => {
  it("is the one uvp's own parser produced, not the URL again", async () => {
    // One owner for "what this URL means". A probe given the string would be a
    // second interpretation of it, and the two could disagree about a default
    // port or an escaped path with nothing to say which was used.
    const seen: unknown[] = [];
    const client: NativeHttp3Probe = {
      availability: async () => ({
        state: "available",
        path: "/tmp/uvcpp-probe",
        libraryVersion: undefined,
      }),
      probe: async (request) => {
        seen.push(request);
        return { kind: "report", report: answeredReport() };
      },
    };
    await send(client, { url: "https://example.test/a%20b?q=1" });
    expect(seen[0]).toMatchObject({
      host: "example.test",
      port: 443,
      path: "/a%20b?q=1",
      // Absent rather than guessed: the probe's own default is `host:port`, and
      // a value invented here would be uvp's reading presented as the wire's.
      authority: undefined,
      caFile: undefined,
      method: "GET",
      // One deadline, not two. An idle clock below the caller's `timeout_ms`
      // would end a run for silence while the deadline the caller set has not
      // passed, and report a service that took 20 s to answer as one that went
      // quiet at 5.
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 5_000,
      maxBodyBytes: 65_536,
    });
  });

  it("carries the caller's headers as the pairs the C ABI takes", async () => {
    const seen: { headers?: unknown; body?: unknown }[] = [];
    const client: NativeHttp3Probe = {
      availability: async () => ({
        state: "available",
        path: "/tmp/uvcpp-probe",
        libraryVersion: undefined,
      }),
      probe: async (request) => {
        seen.push(request);
        return { kind: "report", report: answeredReport() };
      },
    };
    await send(client, { headers: { "x-trace": "1" }, body: "hi", method: "POST" });
    expect(seen[0]?.headers).toEqual([{ name: "x-trace", value: "1" }]);
    // A string, because that is what the C ABI's buffer convention takes; the
    // encoding was resolved here rather than left for the probe to guess.
    expect(seen[0]?.body).toBe("hi");
  });
});
