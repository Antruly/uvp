import { createServer as createHttp2Server } from "node:http2";
import type { ServerHttp2Stream } from "node:http2";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo, Server } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { performRequest } from "./httpClient.js";
import type { HttpRequestSpec } from "./httpClient.js";

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
const startH2c = async (respond: (stream: ServerHttp2Stream) => void): Promise<number> => {
  const server = createHttp2Server();
  server.on("stream", respond);
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

const url = (port: number): string => `http://127.0.0.1:${String(port)}/items`;

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
    await expect(performRequest({ ...SPEC, url: url(port), httpVersion: "auto" })).rejects.toThrow(
      /closed the connection before sending a response/u,
    );
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
});
