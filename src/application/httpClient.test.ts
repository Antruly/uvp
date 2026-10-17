import { createServer as createHttpServer } from "node:http";
import { createServer as createHttp2Server } from "node:http2";
import type { ServerHttp2Stream } from "node:http2";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { performRequest, transportFailureKind } from "./httpClient.js";
import type { HttpRequestSpec, TransportFailureKind } from "./httpClient.js";
import { toUvpError } from "../domain/errors.js";

/**
 * The transport, asked what it saw.
 *
 * The rule this file exists for is the one the whole evidence model rests on: a
 * failure to observe something is not an observation. `performHttp2` used to
 * resolve from `stream.on("end")` whether or not a response header block had
 * arrived, so a peer that accepted the connection and hung up produced a result
 * with `status: 0` and `httpVersion: "2.0"` — two claims about a conversation
 * that never happened. `uvp soap` then read "no fault element in the body" as
 * `outcome: "success"`, and a service that was down was reported as answering.
 *
 * HTTP/1.1 could not reach that state, because it resolves from inside the
 * response callback. These tests hold the h2 path to the same rule, and hold it
 * from both sides: a connection that dies must reject, and a real response —
 * including one with no body at all — must still resolve. Without the second
 * half, deleting the response handling would pass.
 */

const SPEC: Omit<HttpRequestSpec, "url" | "httpVersion"> = {
  method: "GET",
  headers: {},
  body: undefined,
  followRedirects: false,
  maxRedirects: 0,
  verifyTls: true,
  timeoutMs: 5_000,
};

const servers: Server[] = [];

afterAll(() => {
  for (const server of servers) server.close();
});

/** An h2c server that answers every request through `respond`. */
const startH2c = async (
  respond: (
    stream: ServerHttp2Stream,
    headers: Record<string, string | string[] | undefined>,
  ) => void,
): Promise<number> => {
  const server = createHttp2Server();
  // The request's header block is the listener's second argument; `stream.headers`
  // is not populated yet when the `stream` event fires. The stream is annotated
  // because the listener overload infers the base `Http2Stream`, which has no
  // `respond`; the server's own event carries a `ServerHttp2Stream`.
  server.on("stream", (stream: ServerHttp2Stream, headers) => respond(stream, headers));
  servers.push(server);
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
};

/** A listener that accepts and immediately closes, without ever answering. */
const startDeadEnd = async (): Promise<number> => {
  const server = createNetServer((socket) => socket.destroy());
  servers.push(server);
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
};

/**
 * The same listener, counting how many times it was dialled.
 *
 * How many connections one failed request opens is the observable difference
 * between a fallback that is gated on the failure and one that retries whatever
 * went wrong: the second is a real dial, against an endpoint that has already
 * refused this client once.
 */
const startCountedDeadEnd = async (): Promise<{
  readonly port: number;
  readonly connections: () => number;
}> => {
  let connections = 0;
  const server = createNetServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  return { port, connections: () => connections };
};

/** A listener that accepts a connection and then says nothing at all. */
const startSilent = async (): Promise<number> => {
  const server = createNetServer(() => {});
  servers.push(server);
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
};

/**
 * An HTTP/1.1 server that accepts the request and never answers it — the shape
 * of a service that is up and wedged, which is the one an operator most needs
 * told apart from a service that is down.
 *
 * It matters which protocol this server speaks. Under the fallback an `auto`
 * request that times out here is retried over h2, and this server refuses that
 * immediately — so the retry's failure was what reached the caller, and it said
 * `protocol`, not `timeout`.
 */
const startWedgedHttp1 = async (): Promise<number> => {
  const server = createHttpServer(() => {});
  servers.push(server);
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
};

/**
 * A listener that answers in a trickle, forever.
 *
 * The shape that separates a total deadline from an inactivity timer: every
 * chunk resets an inactivity timer, so a client with one would wait here until
 * the fixture gave up. The server holds the socket open until the client leaves,
 * and swallows the write errors that leaving causes.
 */
const startTrickle = async (): Promise<number> => {
  const server = createNetServer((socket: Socket) => {
    socket.on("error", () => socket.destroy());
    socket.write(
      "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n",
    );
    const ticker = setInterval(() => socket.write("1\r\nx\r\n"), 25);
    socket.on("close", () => clearInterval(ticker));
  });
  servers.push(server);
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
};

/**
 * A redirect whose first hop is slow and whose target never answers.
 *
 * A hop that is reached is a hop that spends the caller's deadline, so this is
 * the shape that tells a call-wide budget from a per-attempt one: with the
 * deadline reset at each hop the call takes the delay plus the full timeout,
 * and with one budget it takes the timeout.
 */
const startSlowRedirectToWedged = async (firstHopDelayMs: number): Promise<number> => {
  const server = createHttpServer((request, response) => {
    if (request.url === "/slow-hop") {
      setTimeout(() => {
        response.writeHead(302, { location: "/wedged", "content-length": "0" });
        response.end();
      }, firstHopDelayMs).unref();
      return;
    }
    // `/wedged`: the connection is accepted and nothing is ever sent.
  });
  servers.push(server);
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
};

const url = (port: number): string => `http://127.0.0.1:${String(port)}/items`;

/** The kind a request fails with, and how long it took to fail. */
const failureOf = async (
  spec: HttpRequestSpec,
): Promise<{ readonly kind: TransportFailureKind; readonly elapsedMs: number }> => {
  const started = Date.now();
  const kind = await performRequest(spec).then(
    () => "resolved" as const,
    (cause: unknown) => transportFailureKind(cause),
  );
  const elapsedMs = Date.now() - started;
  if (kind === "resolved") throw new Error("the request was expected to fail and did not");
  return { kind, elapsedMs };
};

describe("a connection that never answered", () => {
  it("rejects instead of reporting a status of zero", async () => {
    // The regression. `status: 0` is not a status any peer sent; it is what the
    // variable was initialised to, and a caller comparing statuses would read it
    // as a response from the service.
    const port = await startDeadEnd();
    await expect(performRequest({ ...SPEC, url: url(port), httpVersion: "2" })).rejects.toThrow(
      /closed the connection before sending a response/u,
    );
  });

  it("rejects on the auto path too, where h2 is a fallback", async () => {
    // `auto` tries HTTP/1.1, and on a failure it retries over h2. That retry is
    // what turned a refused connection into a bogus h2 result for every caller
    // who did not pass `--http-version`, which is every caller by default.
    const port = await startDeadEnd();
    const settled = await performRequest({ ...SPEC, url: url(port), httpVersion: "auto" }).then(
      () => "resolved",
      (cause: unknown) => transportFailureKind(cause),
    );
    // Rejected, and as what it was: the peer took the connection and hung up.
    // The message used to be the *retry's* ("closed the connection before
    // sending a response") because every failure was retried over h2, so the
    // caller was told about a conversation the client had with itself.
    expect(settled).toBe("unreachable");
  });

  it("does not let the failure arrive as a resolved exchange with no body", async () => {
    // Stated as the positive claim it is: whatever the rejection says, the
    // promise must not resolve. A message assertion alone would pass if the
    // promise both rejected and resolved, which promises cannot do — but the
    // shape of the mistake was a resolution, so the shape is what is checked.
    const port = await startDeadEnd();
    const settled = await performRequest({ ...SPEC, url: url(port), httpVersion: "2" }).then(
      (exchange) => ({ resolved: true, status: exchange.status }),
      () => ({ resolved: false, status: -1 }),
    );
    expect(settled.resolved).toBe(false);
  });
});

describe("a connection that answered", () => {
  it("reports the status, the version, and the body it received", async () => {
    // The positive control. A guard that rejected everything would satisfy the
    // tests above and break every working exchange.
    const port = await startH2c((stream) => {
      stream.respond({ ":status": 200, "content-type": "text/plain" });
      stream.end("hello");
    });
    const exchange = await performRequest({ ...SPEC, url: url(port), httpVersion: "2" });
    expect(exchange.status).toBe(200);
    expect(exchange.httpVersion).toBe("2.0");
    expect(exchange.body.toString("utf8")).toBe("hello");
  });

  it("resolves for a response with no body, where no data event ever fires", async () => {
    // 204 is the case that separates "a response arrived" from "bytes arrived".
    // A guard keyed on the first data chunk would reject this, which is why the
    // h2 client tracks the response event instead.
    const port = await startH2c((stream) => {
      stream.respond({ ":status": 204 });
      stream.end();
    });
    const exchange = await performRequest({ ...SPEC, url: url(port), httpVersion: "2" });
    expect(exchange.status).toBe(204);
    expect(exchange.body.byteLength).toBe(0);
  });

  it("sends every caller header, not only accept and content-type", async () => {
    // The h2 path used to pick two names out of `spec.headers` (exact-lowercase
    // `accept` and `content-type`) while the HTTP/1.1 path spread all of them.
    // The same call therefore made two different requests, and a 401 was
    // reported as the service's answer to a request that omitted its
    // `authorization`. `Accept` with a capital A was dropped too, because the
    // lookup was exact-case.
    let seen: Record<string, string | string[] | undefined> = {};
    const port = await startH2c((stream, headers) => {
      seen = headers;
      stream.respond({ ":status": 200 });
      stream.end();
    });
    const exchange = await performRequest({
      ...SPEC,
      url: url(port),
      httpVersion: "2",
      headers: {
        authorization: "Bearer secret",
        Accept: "text/plain",
        "x-request-id": "req-1",
      },
    });
    expect(exchange.status).toBe(200);
    expect(seen["authorization"]).toBe("Bearer secret");
    expect(seen["accept"]).toBe("text/plain");
    expect(seen["x-request-id"]).toBe("req-1");
  });

  it("does not send the fields HTTP/2 forbids, and states the body's length", async () => {
    // RFC 9113 §8.2.2: the connection-specific fields HTTP/1.1 uses do not exist
    // in HTTP/2, and Node rejects a request that carries them. Dropping them is
    // not rewriting the caller's request — there is no connection for them to
    // describe. `content-length` is the other direction: HTTP/1.1 adds it from
    // the body, and the h2 path must too or the peer is told nothing about it.
    let seen: Record<string, string | string[] | undefined> = {};
    const port = await startH2c((stream, headers) => {
      seen = headers;
      stream.respond({ ":status": 200 });
      stream.end();
    });
    await performRequest({
      ...SPEC,
      method: "POST",
      url: url(port),
      httpVersion: "2",
      headers: { connection: "keep-alive", "x-kept": "yes" },
      body: Buffer.from("hello"),
    });
    expect(seen["x-kept"]).toBe("yes");
    expect(seen["connection"]).toBeUndefined();
    expect(seen["content-length"]).toBe("5");
  });
});

/**
 * What kind of failure each one was.
 *
 * The kind decides behaviour, not only wording. `auto` retries over HTTP/2 when
 * the peer did not speak HTTP/1.1 and must not retry anything else, and
 * `uvp_http_request` reports a deadline as `timeout` and a refused connection as
 * `endpoint_unreachable` — two codes an operator acts on differently. Each of
 * those decisions was once a regex over an error message, so a timeout on the
 * default configuration came back classified as an unreachable endpoint.
 */
describe("the kind of a transport failure", () => {
  it("is `protocol` for a peer that does not speak the version it was asked for", async () => {
    // Not reachable through HTTP/1.1 at all: an h2c server's first bytes are a
    // SETTINGS frame, which is what the fallback exists for.
    const port = await startH2c((stream) => {
      stream.respond({ ":status": 200 });
      stream.end("h2c");
    });
    const { kind } = await failureOf({ ...SPEC, url: url(port), httpVersion: "1.1" });
    expect(kind).toBe("protocol");
  });

  it("is `timeout` on the default auto path, where it used to be `unreachable`", async () => {
    // The regression this file was extended for. `auto` starts on HTTP/1.1,
    // the deadline fired there, and the error was thrown away for an h2 retry
    // that a plain HTTP/1.1 server answers with "Protocol error" — so the
    // classification the caller received described the retry rather than the
    // request, and `timeout` was unreachable at the default settings.
    const port = await startWedgedHttp1();
    const { kind } = await failureOf({
      ...SPEC,
      url: url(port),
      httpVersion: "auto",
      timeoutMs: 300,
    });
    expect(kind).toBe("timeout");
  }, 10_000);

  it("is `timeout` for a connection that trickles rather than one that stalls", async () => {
    // A total deadline, not an inactivity timer: every chunk here resets an
    // inactivity timer, and the caller's `timeout_ms` would never fire.
    const port = await startTrickle();
    const { kind, elapsedMs } = await failureOf({
      ...SPEC,
      url: url(port),
      httpVersion: "1.1",
      timeoutMs: 400,
    });
    expect(kind).toBe("timeout");
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("is `unreachable` for a connection that was refused", async () => {
    // The other half of the pair: a client that called every failure a timeout
    // would pass the tests above.
    const { kind } = await failureOf({
      ...SPEC,
      url: "http://127.0.0.1:1/",
      httpVersion: "auto",
      timeoutMs: 2_000,
    });
    expect(kind).toBe("unreachable");
  });

  it("decides whether to retry over h2, and a refusal is not retried", async () => {
    // The gate, stated as what it costs. A peer that hung up is not evidence
    // about which protocol it speaks, so dialling it a second time over h2 is a
    // connection to an endpoint that has already refused this client — and the
    // failure the caller ends up holding is whichever attempt came last.
    const { port, connections } = await startCountedDeadEnd();
    const { kind } = await failureOf({ ...SPEC, url: url(port), httpVersion: "auto" });
    expect(kind).toBe("unreachable");
    expect(connections()).toBe(1);
  });

  it("classifies a failure the transport did not raise as the general case", () => {
    // A value that reached a caller without passing through this module has no
    // kind to read. Guessing a specific one from it would be inventing a
    // classification, so it lands in the bucket that claims the least.
    expect(transportFailureKind(new Error("something else entirely"))).toBe("unreachable");
    expect(transportFailureKind("a string, not an error")).toBe("unreachable");
  });
});

describe("the deadline", () => {
  it("bounds the whole call rather than each protocol attempt", async () => {
    // `auto` makes two attempts against a host that accepts and stalls: the
    // HTTP/1.1 one, then the h2 fallback. When each draws a fresh budget the
    // call takes twice the timeout it was given, and the switch that is
    // supposed to bound the caller's wait bounds nothing.
    const port = await startSilent();
    const { elapsedMs } = await failureOf({
      ...SPEC,
      url: url(port),
      httpVersion: "auto",
      timeoutMs: 300,
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(250);
    expect(elapsedMs).toBeLessThan(600);
  }, 10_000);

  it("is spent by a redirect hop rather than reset after one", async () => {
    // `timeout_ms` is the caller's patience with one question, and a redirect
    // chain is one question. Reset at each hop, the deadline bounds nothing
    // the caller can predict: the call takes as long as the number of hops
    // times the timeout allows.
    const port = await startSlowRedirectToWedged(300);
    const { kind, elapsedMs } = await failureOf({
      ...SPEC,
      url: `http://127.0.0.1:${String(port)}/slow-hop`,
      httpVersion: "auto",
      followRedirects: true,
      maxRedirects: 5,
      timeoutMs: 450,
    });
    expect(kind).toBe("timeout");
    // 300ms on the first hop plus what was left of the budget. A fresh budget
    // for the second hop would put this near 750ms.
    expect(elapsedMs).toBeGreaterThanOrEqual(400);
    expect(elapsedMs).toBeLessThan(700);
  }, 10_000);

  it("still lets the h2 fallback work inside it", async () => {
    // The positive control for the gated retry: a protocol failure is exactly
    // what the fallback is for, and a fix that stopped retrying altogether
    // would break every h2c service on the default configuration.
    const port = await startH2c((stream) => {
      stream.respond({ ":status": 200, "content-type": "text/plain" });
      stream.end("through the fallback");
    });
    const exchange = await performRequest({ ...SPEC, url: url(port), httpVersion: "auto" });
    expect(exchange.status).toBe(200);
    expect(exchange.httpVersion).toBe("2.0");
    expect(exchange.body.toString("utf8")).toBe("through the fallback");
  }, 10_000);
});

/**
 * A request the caller withdrew.
 *
 * `performRequest` had no signal at all: a request already in flight could only
 * end at its own deadline or when the peer answered, and the WebService checked
 * the signal *after* the exchange had completed. That made a cancellation
 * indistinguishable from a completed request for as long as the request took,
 * and it left the caller waiting on a question they had abandoned. A
 * cancellation is also not a transport finding, so it must not arrive as one.
 */
describe("a withdrawn request", () => {
  const aborted = async (
    spec: HttpRequestSpec,
  ): Promise<{ readonly code: string; readonly elapsedMs: number }> => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = performRequest(spec, controller.signal).then(
      () => undefined,
      (cause: unknown) => toUvpError(cause),
    );
    setTimeout(() => controller.abort(), 50);
    const failure = await pending;
    return { code: failure?.code ?? "resolved", elapsedMs: Date.now() - started };
  };

  it("stops an in-flight HTTP/1.1 request and rejects as cancelled", async () => {
    const port = await startSilent();
    const { code, elapsedMs } = await aborted({
      ...SPEC,
      url: url(port),
      httpVersion: "1.1",
      timeoutMs: 30_000,
    });
    expect(code).toBe("cancelled");
    // The 30 s deadline is not what ended this call.
    expect(elapsedMs).toBeLessThan(1_000);
  }, 10_000);

  it("destroys an in-flight HTTP/2 request rather than letting it finish", async () => {
    const port = await startSilent();
    const { code, elapsedMs } = await aborted({
      ...SPEC,
      url: url(port),
      httpVersion: "2",
      timeoutMs: 30_000,
    });
    expect(code).toBe("cancelled");
    expect(elapsedMs).toBeLessThan(1_000);
  }, 10_000);

  it("opens nothing when the caller had already withdrawn", async () => {
    // A signal that fired before the call is not permission to dial the peer
    // and report a connection that was opened on the caller's behalf.
    const { port, connections } = await startCountedDeadEnd();
    const controller = new AbortController();
    controller.abort();
    const failure = await performRequest(
      { ...SPEC, url: url(port), httpVersion: "1.1" },
      controller.signal,
    ).then(
      () => undefined,
      (cause: unknown) => toUvpError(cause),
    );
    expect(failure?.code).toBe("cancelled");
    expect(connections()).toBe(0);
  });
});
