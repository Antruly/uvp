import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { NativeHttp3ProbeRunner } from "./NativeHttp3ProbeRunner.js";
import type { NativeHttp3Outcome, NativeHttp3Report } from "../../application/NativeHttp3Probe.js";
import type { ProcessOutcome, RunProcessOptions } from "../processRunner.js";

/**
 * The HTTP/3 runner, with the child scripted.
 *
 * The same split the WebSocket runner's tests make, for the same reason: what is
 * under test is the *conversation* — the JSON that goes to the probe and what each
 * of its endings becomes on the way back. The probe itself needs a C++ toolchain
 * and a libuvcpp built with `UVCPP_ENABLE_CAPI=ON`, so a test that wanted both to
 * ask "is a missing exchange reported as unavailable" would skip on every host that
 * has neither.
 *
 * `runProcess` is injected; the executable check is not. The runner asks the
 * filesystem whether its candidate can be run before spawning anything, so the
 * scripted answers sit behind a real `accessSync` on a real executable.
 */

/** An executable that is definitely present: the Node running this test. */
const EXECUTABLE = process.execPath;

const SIGNAL = new AbortController().signal;

/** What an available probe answers `--version` with, including its exchange list. */
const VERSION = JSON.stringify({
  probe: "uvcpp-capi",
  abi_version: 1,
  header_abi_version: 1,
  library_version: "1.7.0",
  exchanges: ["websocket", "http3"],
});

/** The fields `runProcess` always fills in, so a test states only the ones it changed. */
const BASE: ProcessOutcome = {
  command: "uvcpp-probe",
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  durationMs: 1,
  stdout: "",
  stderr: "",
  stdoutBytes: 0,
  stderrBytes: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
};

/** A runner whose child answers from a script, in call order. */
const runnerWith = (...answers: readonly (Partial<ProcessOutcome> | Error)[]) => {
  const calls: RunProcessOptions[] = [];
  const remaining = [...answers];
  const runner = new NativeHttp3ProbeRunner({
    env: { UVP_NATIVE_PROBE: EXECUTABLE },
    availabilityTimeoutMs: 1_000,
    killGraceMs: 10,
    runProcess: async (options) => {
      calls.push(options);
      const answer = remaining.shift() ?? {};
      if (answer instanceof Error) throw answer;
      return { ...BASE, command: options.command, ...answer };
    },
  });
  return { runner, calls };
};

/** An available runner: `--version` answers, and then whatever the test scripts. */
const available = (...answers: readonly (Partial<ProcessOutcome> | Error)[]) =>
  runnerWith({ stdout: VERSION }, ...answers);

const reportOf = (outcome: NativeHttp3Outcome): NativeHttp3Report => {
  if (outcome.kind !== "report") {
    throw new Error(`expected a report, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  }
  return outcome.report;
};

/** The JSON the runner wrote to a child's stdin. */
const requestOf = (call: RunProcessOptions | undefined): Record<string, unknown> => {
  if (call?.stdin === undefined) throw new Error("no request was written to the child's stdin");
  return JSON.parse(call.stdin) as Record<string, unknown>;
};

/** An answered run, so a test can change one field and leave the rest valid. */
const report = (overrides: Record<string, unknown> = {}): Partial<ProcessOutcome> => ({
  stdout: JSON.stringify({
    probe: "uvcpp-capi",
    exchange: "http3",
    url: "https://127.0.0.1:8462/hello",
    host: "127.0.0.1",
    port: 8462,
    method: "GET",
    path: "/hello",
    authority: "127.0.0.1:8462",
    verify_peer: false,
    handshake_completed: true,
    handshake_ok: true,
    handshake_status: 0,
    alpn: "h3",
    request_sent: true,
    stream_id: 0,
    send_attempts: 1,
    last_send_error: null,
    answered: true,
    status: 200,
    response_error: 0,
    headers: { "content-type": "text/plain" },
    headers_observed: ["content-type", "content-length"],
    body: "hello over HTTP/3",
    body_bytes: 17,
    bytes_in: 120,
    bytes_out: 90,
    disconnected: true,
    error: null,
    stop_reason: "answered",
    total_ms: 23,
    not_observable: ["response trailers"],
    ...overrides,
  }),
});

const REQUEST = {
  url: "https://127.0.0.1:8462/hello",
  host: "127.0.0.1",
  port: 8462,
  path: "/hello",
  authority: undefined,
  method: "GET",
  headers: [],
  body: "",
  bodyBase64: undefined,
  caFile: undefined,
  idleTimeoutMs: 5_000,
  totalTimeoutMs: 20_000,
  maxBodyBytes: 65_536,
} as const;

describe("deciding whether the HTTP/3 probe can be used here", () => {
  it("is available when the probe lists the http3 exchange", async () => {
    const { runner } = runnerWith({ stdout: VERSION });
    expect(await runner.availability(SIGNAL)).toEqual({
      state: "available",
      path: EXECUTABLE,
      libraryVersion: "1.7.0",
    });
  });

  it("is unavailable when the probe does not have the exchange, and says which it has", async () => {
    // The asymmetry with the WebSocket runner, and the reason it exists: the
    // exchange and the `exchanges` field landed together, so a build that does not
    // list `http3` is definitely one that cannot run it. Reporting that here is a
    // definite finding — the probe answered the question about itself and the
    // answer was no — which is a different thing from not having asked.
    const { runner } = runnerWith({
      stdout: JSON.stringify({
        probe: "uvcpp-capi",
        abi_version: 1,
        header_abi_version: 1,
        library_version: "1.7.0",
        exchanges: ["websocket"],
      }),
    });
    const availability = await runner.availability(SIGNAL);
    expect(availability.state).toBe("unavailable");
    if (availability.state === "unavailable") {
      expect(availability.reason).toContain("can run websocket but not http3");
    }
  });

  it("is unavailable when the probe predates the exchange list entirely", async () => {
    // An older probe answers `--version` without `exchanges` at all. For this
    // exchange that is a definite no for the reason above — and the remedy named
    // is the one that works, rather than "it does not have http3", which a reader
    // could take to mean the install is wrong.
    const { runner } = runnerWith({
      stdout: JSON.stringify({
        probe: "uvcpp-capi",
        abi_version: 1,
        header_abi_version: 1,
        library_version: "1.7.0",
      }),
    });
    const availability = await runner.availability(SIGNAL);
    expect(availability.state).toBe("unavailable");
    if (availability.state === "unavailable") {
      expect(availability.reason).toContain("build:native-probe");
    }
  });

  it("repeats the build's own reason when the probe was built without the exchange", async () => {
    // The probe knows something this layer cannot: it asked a compiler, at build
    // time, whether the install had the HTTP/3 C ABI, and it carries the answer.
    // When it has one, that sentence is the finding — `npm run build:native-probe`
    // is the wrong remedy for an install built without HTTP3, because repeating the
    // build produces the same binary.
    const said =
      "this probe was built without the http3 exchange: the libuvcpp install it was compiled " +
      "against did not expose the HTTP/3 C ABI";
    const { runner } = runnerWith({
      stdout: JSON.stringify({
        probe: "uvcpp-capi",
        abi_version: 1,
        header_abi_version: 1,
        library_version: "1.7.0",
        exchanges: ["websocket"],
        unavailable_exchanges: { http3: said },
      }),
    });
    const availability = await runner.availability(SIGNAL);
    expect(availability.state).toBe("unavailable");
    if (availability.state === "unavailable") {
      expect(availability.reason).toContain(said);
      expect(availability.reason).not.toContain("build:native-probe");
    }
  });

  it("keeps the generic sentence when the probe answered the list and gave no reason", async () => {
    // An empty `unavailable_exchanges` is a probe that was asked and has nothing to
    // explain, which is a different answer from a probe too old to have the field:
    // the first falls back to the sentence about rebuilding, the second to the one
    // about an exchange the build predates. Both are covered, because an
    // implementation that read an empty object as "no answer" would collapse them.
    const { runner } = runnerWith({
      stdout: JSON.stringify({
        probe: "uvcpp-capi",
        abi_version: 1,
        header_abi_version: 1,
        library_version: "1.7.0",
        exchanges: ["websocket"],
        unavailable_exchanges: {},
      }),
    });
    const availability = await runner.availability(SIGNAL);
    expect(availability.state).toBe("unavailable");
    if (availability.state === "unavailable") {
      expect(availability.reason).toContain("can run websocket but not http3");
    }
  });

  it("does not run a probe at all when the stack is not available", async () => {
    const calls: RunProcessOptions[] = [];
    const runner = new NativeHttp3ProbeRunner({
      env: { UVP_NATIVE_PROBE: join(tmpdir(), "uvp-no-such-probe-http3") },
      runProcess: async (options) => {
        calls.push(options);
        return { ...BASE, command: options.command };
      },
    });

    const outcome = await runner.probe(REQUEST, SIGNAL);
    expect(outcome.kind).toBe("stack-unavailable");
    expect(calls).toHaveLength(0);
  });
});

describe("writing the request the probe reads", () => {
  it("names the exchange and passes the parsed URL facts rather than a URL", async () => {
    const { runner, calls } = available(report());
    await runner.probe(REQUEST, SIGNAL);

    const written = requestOf(calls[1]);
    expect(written["exchange"]).toBe("http3");
    expect(written["host"]).toBe("127.0.0.1");
    expect(written["port"]).toBe(8462);
    expect(written["path"]).toBe("/hello");
    // The URL travels for the report only. uvp's URI parser is the one owner of
    // "what this URL means", so the probe is handed the facts that parser produced
    // instead of a string to take apart a second time.
    expect(written["url"]).toBe("https://127.0.0.1:8462/hello");
    // Absent rather than empty: the probe fills in `host:port` when there is no
    // authority, and an empty string is a different input that it treats
    // differently.
    expect(written["authority"]).toBeUndefined();
    // Likewise for the CA bundle, and here it matters twice over: absent means
    // "do not verify", while an empty string would be a CA file the probe could
    // not open.
    expect(written["ca_file"]).toBeUndefined();
  });

  it("writes a CA bundle and an authority when the caller gave them", async () => {
    const { runner, calls } = available(report());
    await runner.probe(
      {
        ...REQUEST,
        authority: "example.test",
        headers: [{ name: "accept", value: "text/plain" }],
        caFile: "/etc/ssl/private/ca.pem",
      },
      SIGNAL,
    );

    const written = requestOf(calls[1]);
    expect(written["authority"]).toBe("example.test");
    expect(written["ca_file"]).toBe("/etc/ssl/private/ca.pem");
    expect(written["headers"]).toEqual([{ name: "accept", value: "text/plain" }]);
  });

  it("carries a body's exact bytes alongside the text form", async () => {
    // The protocol is JSON, which cannot carry a byte that is not valid UTF-8.
    // `body_base64` is the lossless spelling; `body` stays for a probe that
    // predates it, and both travel so an older probe keeps receiving text bodies.
    const { runner, calls } = available(report());
    await runner.probe({ ...REQUEST, method: "POST", body: "\u0000�", bodyBase64: "AP8=" }, SIGNAL);

    const written = requestOf(calls[1]);
    expect(written["body_base64"]).toBe("AP8=");
    expect(written["body"]).toBe("\u0000�");
  });

  it("omits body_base64 when the request has no body", async () => {
    const { runner, calls } = available(report());
    await runner.probe(REQUEST, SIGNAL);
    expect(requestOf(calls[1])["body_base64"]).toBeUndefined();
  });

  it("bounds the report by the body it asked to keep", async () => {
    const small = available(report());
    await small.runner.probe({ ...REQUEST, maxBodyBytes: 1_024 }, SIGNAL);

    const large = available(report());
    await large.runner.probe({ ...REQUEST, maxBodyBytes: 1_048_576 }, SIGNAL);

    const smallBudget = small.calls[1]?.maxOutputBytes ?? 0;
    const largeBudget = large.calls[1]?.maxOutputBytes ?? 0;
    expect(largeBudget).toBeGreaterThan(smallBudget);
    expect(largeBudget).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});

describe("reading the report the probe wrote", () => {
  it("maps a report to the port's facts, including the ones that are absences", async () => {
    const { runner } = available(report());
    const mapped = reportOf(await runner.probe(REQUEST, SIGNAL));

    expect(mapped.alpn).toBe("h3");
    expect(mapped.answered).toBe(true);
    expect(mapped.status).toBe(200);
    expect(mapped.body).toBe("hello over HTTP/3");
    expect(mapped.headers).toEqual({ "content-type": "text/plain" });
    // The names the probe looked for, kept because a short list would otherwise
    // read as a complete header set — and on this stack there is no such thing.
    // The C ABI reads one response header at a time and has no header-list call,
    // which is also why `headers` is a map and not a list: neither the wire order
    // nor a repeated header is reachable here.
    expect(mapped.headersObserved).toEqual(["content-type", "content-length"]);
    expect(mapped.streamId).toBe(0);
    expect(mapped.stopReason).toBe("answered");
    expect(mapped.libraryVersion).toBe("1.7.0");
    expect(mapped.error).toBeUndefined();
    expect(mapped.bodyOmitted).toBeUndefined();
  });

  it("keeps no stream number apart from stream zero", async () => {
    // The report writes null when nothing was sent, and 0 is a perfectly ordinary
    // stream. A mapping that defaulted to 0 would turn "nothing was sent" into
    // "the request went out first", which is the opposite finding.
    const { runner } = available(
      report({
        request_sent: false,
        stream_id: null,
        send_attempts: 0,
        answered: false,
        status: null,
        stop_reason: "idle",
      }),
    );
    const mapped = reportOf(await runner.probe(REQUEST, SIGNAL));
    expect(mapped.streamId).toBeUndefined();
    expect(mapped.requestSent).toBe(false);
  });

  it("carries the code when the handshake itself failed", async () => {
    // A host that does not resolve: the probe reports it rather than refusing, so
    // it arrives as a run that never handshook, with the library's own name for
    // the code. That is a fact about the target, and this is the shape it travels
    // in.
    const { runner } = available(
      report({
        handshake_completed: false,
        handshake_ok: false,
        handshake_status: -3008,
        alpn: "",
        request_sent: false,
        stream_id: null,
        send_attempts: 0,
        answered: false,
        status: null,
        error: { what: "getaddrinfo ENOTFOUND", code: -3008 },
        stop_reason: null,
      }),
    );
    const mapped = reportOf(await runner.probe(REQUEST, SIGNAL));
    expect(mapped.handshakeCompleted).toBe(false);
    expect(mapped.handshakeStatus).toBe(-3008);
    expect(mapped.error).toEqual({ what: "getaddrinfo ENOTFOUND", code: -3008 });
    expect(mapped.stopReason).toBeUndefined();
  });

  it("keeps a body it could not carry, and says why", async () => {
    // The probe reports the body's real length either way. A caller reading an
    // empty body has to be able to tell "the peer sent nothing" from "it sent more
    // than I asked to keep".
    const { runner } = available(
      report({ body: "", body_bytes: 20_000_000, body_omitted: "longer than max_body_bytes" }),
    );
    const mapped = reportOf(await runner.probe(REQUEST, SIGNAL));
    expect(mapped.body).toBe("");
    expect(mapped.bodyBytes).toBe(20_000_000);
    expect(mapped.bodyOmitted).toBe("longer than max_body_bytes");
  });

  it("calls a report it cannot read version skew, not an observation", async () => {
    const { runner } = available(report({ alpn: undefined }));
    const outcome = await runner.probe(REQUEST, SIGNAL);
    expect(outcome.kind).toBe("probe-failed");
    if (outcome.kind === "probe-failed") {
      expect(outcome.message).toContain("missing fields this uvp needs");
      expect(outcome.message).toContain("alpn");
    }
  });

  it("refuses to map a stop reason it does not know", async () => {
    const { runner } = available(report({ stop_reason: "peer-went-away" }));
    const outcome = await runner.probe(REQUEST, SIGNAL);
    expect(outcome.kind).toBe("probe-failed");
    if (outcome.kind === "probe-failed") {
      expect(outcome.message).toContain("stopped for a reason this uvp does not know");
      expect(outcome.message).toContain('"peer-went-away"');
    }
  });

  it("refuses a header map that is not a map of strings", async () => {
    // There is nowhere for a bad entry to go: a name-to-value map has no room for
    // the shape this uvp does not know, so the honest reading is "this is not the
    // report I was built against" rather than a dropped header.
    const { runner } = available(report({ headers: { "content-type": 7 } }));
    const outcome = await runner.probe(REQUEST, SIGNAL);
    expect(outcome.kind).toBe("probe-failed");
    if (outcome.kind === "probe-failed") {
      expect(outcome.message).toContain("headers");
    }
  });
});

describe("the refusals the probe makes itself", () => {
  it("passes on a refusal in the probe's own words rather than inferring one", async () => {
    const { runner } = available({
      exitCode: 2,
      stdout: JSON.stringify({
        probe: "uvcpp-capi",
        error: { what: "the request's port is not in 1..65535" },
      }),
      stderr: "uvcpp-probe: the request's port is not in 1..65535\n",
    });

    expect(await runner.probe(REQUEST, SIGNAL)).toEqual({
      kind: "request-refused",
      message: "the request's port is not in 1..65535",
    });
  });

  it("reads exit 3 as a stack that cannot run here, with the probe's reason", async () => {
    const { runner } = available({
      exitCode: 3,
      stdout: JSON.stringify({
        probe: "uvcpp-capi",
        error: { what: "uvcpp_c_quic_crypto_init failed" },
      }),
    });

    expect(await runner.probe(REQUEST, SIGNAL)).toEqual({
      kind: "stack-unavailable",
      state: "unavailable",
      reason: "uvcpp_c_quic_crypto_init failed",
      path: EXECUTABLE,
    });
  });
});

describe("when no report arrives", () => {
  it("reports a probe that had to be killed as a fact about the probe", async () => {
    const { runner } = available({
      timedOut: true,
      exitCode: null,
      signal: "SIGKILL",
      stderr: "uvcpp-probe: still running\n",
    });

    const outcome = await runner.probe({ ...REQUEST, totalTimeoutMs: 5_000 }, SIGNAL);
    expect(outcome.kind).toBe("probe-failed");
    if (outcome.kind === "probe-failed") {
      expect(outcome.message).toContain("5010 ms");
      expect(outcome.detail).toBe("uvcpp-probe: still running");
    }
  });

  it("turns a child that could not be started into a sentence", async () => {
    const { runner } = available(new Error("spawn EACCES"));
    expect(await runner.probe(REQUEST, SIGNAL)).toEqual({
      kind: "probe-failed",
      message: "spawn EACCES",
      detail: "",
    });
  });

  it("reports a cancelled run as cancelled rather than as a probe that saw nothing", async () => {
    const controller = new AbortController();
    const { runner } = available(report());
    controller.abort();
    expect(await runner.probe(REQUEST, controller.signal)).toEqual({ kind: "cancelled" });
  });
});
