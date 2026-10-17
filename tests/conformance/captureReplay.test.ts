import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { performRequest } from "../../src/application/httpClient.js";
import type { HttpExchange } from "../../src/application/httpClient.js";
import { createToolHandlers, handlerFor } from "../../src/composition/toolHandlers.js";
import { createUvpServices } from "../../src/composition/uvpServices.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import type { ToolContract } from "../../src/contracts/toolContractTypes.js";
import { toUvpError } from "../../src/domain/errors.js";
import { freePort } from "../support/ports.js";
import { startFixture } from "./fixtureServer.js";
import type { FixtureServer } from "./fixtureServer.js";

/**
 * Replaying a capture as a regression suite.
 *
 * A capture records what a client sent and what came back; a replay sends the
 * same requests again and asks whether the answers are still the answers. That
 * claim has four ways to be wrong, and every one of them reads as success:
 *
 * - **A replay that sent nothing and compared nothing** reports zero
 *   differences, which is what a passing run reports. Hence `outcome`, and hence
 *   this file driving traffic through a real proxy first: with no recorded
 *   exchanges, `verified` and `unknown` are one field apart and nothing else.
 * - **A `POST` replayed is a second write.** Nothing here can know whether an
 *   endpoint is idempotent, so the tool is not allowed to guess — the test
 *   captures a write and requires the replay to report it as skipped by name.
 * - **A body that was cut short is not a body that changed.** The session's own
 *   recording limit and the transport's read limit both produce prefixes, and a
 *   digest of a prefix differs from a digest of the whole, which reads exactly
 *   like a regression in the service.
 * - **A `host` header replayed as recorded points at the service the capture came
 *   from.** Replaying against a second origin is the case that tells the two
 *   apart, so that is what the cross-origin test does: the target echoes the
 *   headers it was sent, and a replayed `host` would make the echo match the
 *   record it was supposed to differ from.
 *
 * The fixture is the target, and it is a real process over a real socket — the
 * recording half is `uvp_capture_start`'s proxy, not a stub. The one thing added
 * to it for this file is `/status`, a route whose status the caller chooses:
 * without it, the same request to the same fixed route cannot answer differently
 * the second time, and a *status* difference could not be produced at all.
 */

const TIMEOUT = 30_000;

let fixture: FixtureServer;
/** A second target, for the replays that must not go where the capture came from. */
let elsewhere: FixtureServer;
let services: ReturnType<typeof createUvpServices>;
let handlers: ReturnType<typeof createToolHandlers>;
let signal: AbortSignal;

const call = async (name: string, input: unknown): Promise<Record<string, unknown>> =>
  await handlerFor(handlers, name)(input, { signal });

/** A result, checked against the contract that describes it, as the CLI/MCP must. */
const conforming = async (name: string, input: unknown): Promise<Record<string, unknown>> => {
  const output = await call(name, input);
  const contract = toolContract(name) as ToolContract | undefined;
  if (contract === undefined) throw new Error(`${name} is not a known contract`);
  const parsed = contract.outputSchema.safeParse(output);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(`${name} produced output its own contract rejects:\n${issues}`);
  }
  return output;
};

const refusalCode = async (name: string, input: unknown): Promise<string> => {
  try {
    await call(name, input);
  } catch (cause) {
    return toUvpError(cause).code;
  }
  throw new Error(`${name} was expected to refuse ${JSON.stringify(input)} and did not`);
};

interface Capture {
  readonly id: string;
  /** The proxy's origin, which is what a client is pointed at. */
  readonly proxy: string;
}

/**
 * A capture session, started and stopped around the body.
 *
 * Stopping matters as much as starting here: the session owns a listening
 * socket, and a test that leaves one bound keeps the worker alive after the last
 * assertion. `stop` goes through the tool rather than through the store, because
 * that is the path a caller has.
 */
const withCapture = async <T>(
  input: Record<string, unknown>,
  body: (capture: Capture) => Promise<T>,
): Promise<T> => {
  const started = await conforming("uvp_capture_start", {
    listen_port: await freePort(),
    upstream: fixture.origin,
    ...input,
  });
  const capture: Capture = {
    id: String(started["capture_id"]),
    proxy: String(started["proxy_url"]),
  };
  try {
    return await body(capture);
  } finally {
    await call("uvp_capture_read", { capture_id: capture.id, limit: 1, stop: true });
  }
};

/**
 * Note what the targets were doing when a request through the proxy failed, then
 * let the failure go.
 *
 * Written for the one failure this lane has produced that nothing explains: a
 * `TransportFailure: socket hang up` from a loopback target, seen twice inside a
 * full gate (2026-10-16T05:59:33Z and 06:56Z) and never in the thirty-odd runs of
 * this file alone. A socket hang up is a peer that closed a connection under a
 * request, and the three ends of that request are the client, the proxy and the
 * fixture — all in-process but the last, which is a child process whose exit and
 * output nothing here read. Its state is the half a failing run can answer for
 * itself, so the failure now carries it rather than leaving the next reader to
 * re-derive whether the target was even there.
 *
 * Logged and rethrown, never wrapped: the error a test asserts on has to stay the
 * error it was, and a diagnostic that changed it would be a second defect.
 */
const noteTargets = (what: string, cause: unknown): void => {
  console.error(
    `${what} failed: ${String(cause)}\n` +
      `  fixture: ${fixture.state()}\n` +
      `  elsewhere: ${elsewhere.state()}`,
  );
};

/** Drive one request through the capture's proxy, as a client would. */
const through = async (
  capture: Capture,
  path: string,
  options: { readonly method?: string; readonly body?: string } = {},
): Promise<HttpExchange> => {
  const url = `${capture.proxy}${path}`;
  try {
    return await performRequest({
      url,
      method: options.method ?? "GET",
      headers: {},
      body: options.body === undefined ? undefined : Buffer.from(options.body, "utf8"),
      httpVersion: "auto",
      followRedirects: false,
      maxRedirects: 0,
      verifyTls: true,
      timeoutMs: 10_000,
    });
  } catch (cause) {
    noteTargets(`a request through the proxy to ${url}`, cause);
    throw cause;
  }
};

interface ReplayExchange {
  readonly exchange_id: string;
  readonly method: string;
  readonly url: string;
  readonly replayed_url: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly compared: readonly string[];
  readonly recorded_status?: number;
  readonly observed_status?: number;
  readonly recorded_body_digest?: string;
  readonly observed_body_digest?: string;
  readonly error?: string;
}

const exchangesOf = (output: Record<string, unknown>): readonly ReplayExchange[] =>
  (output["exchanges"] ?? []) as readonly ReplayExchange[];

/**
 * Replay a capture, with the same note on the targets if the replay itself fails.
 *
 * The replay performs its own requests from inside the handler, so a transport
 * failure on that hop would otherwise arrive as a `UvpFailure` naming neither end.
 * A replay whose *result* says `failed` is not a throw and does not come here.
 */
const replay = async (capture: Capture, input: unknown = {}): Promise<Record<string, unknown>> => {
  try {
    return await conforming("uvp_capture_replay", { capture_id: capture.id, ...(input as object) });
  } catch (cause) {
    noteTargets("a capture replay", cause);
    throw cause;
  }
};

beforeAll(async () => {
  fixture = await startFixture();
  elsewhere = await startFixture();
  services = createUvpServices();
  handlers = createToolHandlers(services);
  signal = new AbortController().signal;
}, TIMEOUT);

afterAll(async () => {
  await fixture.stop();
  await elsewhere.stop();
});

describe("a capture replayed against the origin it came from", () => {
  it(
    "matches what was recorded, and says which facts it compared",
    async () => {
      await withCapture({ max_exchanges: 10 }, async (capture) => {
        // Two routes whose bodies do not depend on the request, because a body
        // that echoes request headers cannot match across a replay: the proxy
        // forwarded the connection headers it was given, and a replay recomputes
        // them. That is stated in the result's limitations and demonstrated by
        // the cross-origin test below; it is not what this test is about.
        expect((await through(capture, "/hello")).status).toBe(200);
        expect((await through(capture, "/healthz")).status).toBe(200);

        const output = await replay(capture);

        expect(output["outcome"]).toBe("verified");
        expect(output["matched"]).toBe(2);
        expect(output["differed"]).toBe(0);
        expect(output["skipped"]).toBe(0);
        expect(output["not_comparable"]).toBe(0);
        // The default target is the origin the capture was taken from, which is
        // the whole point of a replay with no arguments.
        expect(output["target"]).toBe(fixture.origin);

        for (const entry of exchangesOf(output)) {
          expect(entry.outcome).toBe("matched");
          expect(entry.compared).toEqual(["status", "body"]);
          expect(entry.recorded_status).toBe(200);
          expect(entry.observed_status).toBe(200);
          // The digests are equal, and they are reported rather than being left
          // as an assertion about bytes nobody can see.
          expect(entry.observed_body_digest).toBe(entry.recorded_body_digest);
        }
      });
    },
    TIMEOUT,
  );

  it(
    "reports a body that changed as a difference, with the status still matching",
    async () => {
      await withCapture({ max_exchanges: 10 }, async (capture) => {
        await through(capture, "/headers");

        // `/headers` echoes the request headers it was sent, so asking the same
        // URL with one header changed is how a body difference is produced on
        // purpose rather than waited for.
        const output = await replay(capture, { headers: { "x-uvp-marker": "changed" } });

        expect(output["outcome"]).toBe("failed");
        expect(output["differed"]).toBe(1);
        const [entry] = exchangesOf(output);
        expect(entry?.outcome).toBe("differs");
        expect(entry?.compared).toEqual(["status", "body"]);
        expect(entry?.recorded_status).toBe(200);
        expect(entry?.observed_status).toBe(200);
        expect(entry?.observed_body_digest).not.toBe(entry?.recorded_body_digest);
      });
    },
    TIMEOUT,
  );

  it(
    "reports a status that changed even though the body did not",
    async () => {
      await withCapture({ max_exchanges: 10 }, async (capture) => {
        // `/status` answers whatever `x-uvp-status` names, with a fixed body —
        // so the replay's own header override is the only thing that differs, and
        // the equal digests below are what proves it.
        await through(capture, "/status");

        const output = await replay(capture, { headers: { "x-uvp-status": "503" } });

        expect(output["outcome"]).toBe("failed");
        const [entry] = exchangesOf(output);
        expect(entry?.outcome).toBe("differs");
        expect(entry?.compared).toEqual(["status", "body"]);
        expect(entry?.recorded_status).toBe(200);
        expect(entry?.observed_status).toBe(503);
        expect(entry?.observed_body_digest).toBe(entry?.recorded_body_digest);
      });
    },
    TIMEOUT,
  );
});

describe("what a replay refuses to send", () => {
  it(
    "never sends a method that writes, and names the ones it left alone",
    async () => {
      await withCapture({ max_exchanges: 10 }, async (capture) => {
        await through(capture, "/hello");
        const written = await through(capture, "/echo", {
          method: "POST",
          body: JSON.stringify({ value: 1 }),
        });
        expect(written.status).toBe(200);

        const output = await replay(capture);

        expect(output["skipped"]).toBe(1);
        expect(output["skipped_methods"]).toEqual(["POST"]);
        expect(output["matched"]).toBe(1);
        // One difference would be a failure, but a skip is not a difference and
        // it is not a pass either: nothing compared that exchange, so the run is
        // partial rather than verified.
        expect(output["outcome"]).toBe("partial");

        const skipped = exchangesOf(output).find((entry) => entry.outcome === "skipped");
        expect(skipped?.method).toBe("POST");
        expect(skipped?.compared).toEqual([]);
        expect(skipped?.reason).toContain("POST");
        expect(skipped?.reason).toContain("second write");
        // No status was invented for it: the exchange was not sent, so there is
        // no observation to report.
        expect(skipped?.observed_status).toBeUndefined();
      });
    },
    TIMEOUT,
  );

  it(
    "refuses a target that carries a path, rather than guessing where the path goes",
    async () => {
      await withCapture({}, async (capture) => {
        const code = await refusalCode("uvp_capture_replay", {
          capture_id: capture.id,
          target: `${fixture.origin}/api`,
        });
        expect(code).toBe("invalid_request");
      });
    },
    TIMEOUT,
  );

  it(
    "refuses a target that is not an absolute URL",
    async () => {
      await withCapture({}, async (capture) => {
        const code = await refusalCode("uvp_capture_replay", {
          capture_id: capture.id,
          target: "127.0.0.1:8080",
        });
        expect(code).toBe("invalid_request");
      });
    },
    TIMEOUT,
  );
});

describe("what a replay counts as no evidence at all", () => {
  it(
    "does not call a comparison with nothing to compare a pass",
    async () => {
      await withCapture({ max_exchanges: 10 }, async (capture) => {
        await through(capture, "/hello");
        // A port that was reserved and released, so nothing is listening on it:
        // the replay's requests fail, and every failure is a fact about this
        // attempt rather than about the service that was recorded.
        const dead = await freePort();

        const output = await replay(capture, { target: `http://127.0.0.1:${String(dead)}` });

        expect(output["not_comparable"]).toBe(1);
        expect(output["matched"]).toBe(0);
        expect(output["differed"]).toBe(0);
        expect(output["outcome"]).toBe("unknown");

        const [entry] = exchangesOf(output);
        expect(entry?.compared).toEqual([]);
        expect(entry?.observed_status).toBeUndefined();
        expect(entry?.error).not.toBeUndefined();
        expect(entry?.reason).toContain("did not complete");

        // And the envelope has to carry it as an unknown, because `outcome` is a
        // verdict a caller may not read: a result with no unknowns would let a
        // client that ignores that field present this as a clean run.
        const unknowns = (output["unknowns"] ?? []) as { reason: string; question: string }[];
        expect(unknowns).toHaveLength(1);
        expect(unknowns[0]?.reason).toBe("not_attempted");
        expect(unknowns[0]?.question).toContain("still answer");
      });
    },
    TIMEOUT,
  );

  it(
    "does not hold a target to a response that was never recorded",
    async () => {
      // The capture's upstream never existed, so what it recorded is an exchange
      // with an error and no response. Replaying that against a service that is
      // up is not a match and not a difference: there is nothing to compare, and
      // the honest report says so rather than crediting the target with a pass.
      const dead = await freePort();
      const started = await conforming("uvp_capture_start", {
        listen_port: await freePort(),
        upstream: `http://127.0.0.1:${String(dead)}`,
        max_exchanges: 10,
      });
      const capture: Capture = {
        id: String(started["capture_id"]),
        proxy: String(started["proxy_url"]),
      };
      try {
        // The proxy answers its client with 502 and records the failure.
        expect((await through(capture, "/hello")).status).toBe(502);

        const output = await replay(capture, { target: fixture.origin });

        expect(output["outcome"]).toBe("unknown");
        expect(output["not_comparable"]).toBe(1);
        const [entry] = exchangesOf(output);
        expect(entry?.outcome).toBe("not_comparable");
        expect(entry?.recorded_status).toBeUndefined();
        // The replay itself succeeded — the target answered — and the missing
        // half is the record's, which is the distinction the reason has to make.
        expect(entry?.observed_status).toBe(200);
        expect(entry?.reason).toContain("carries no response");
      } finally {
        await call("uvp_capture_read", { capture_id: capture.id, limit: 1, stop: true });
      }
    },
    TIMEOUT,
  );
});

describe("bodies that are not whole", () => {
  it(
    "does not compare a body the session's recording limit cut, and says which limit bit",
    async () => {
      await withCapture({ max_body_bytes: 8, max_exchanges: 10 }, async (capture) => {
        await through(capture, "/hello");

        const output = await replay(capture);

        // The status is comparable and matched; the body is a prefix on the
        // recorded side, so comparing digests would compare different lengths.
        // The exchange is `matched` and the *run* is `partial`: a status that
        // matched while the body was never looked at is not a verified exchange,
        // and a caller reading only the verdict has to be told that.
        expect(output["outcome"]).toBe("partial");
        expect(output["matched"]).toBe(1);
        expect(output["body_limit_bytes"]).toBe(8);

        const [entry] = exchangesOf(output);
        expect(entry?.outcome).toBe("matched");
        expect(entry?.compared).toEqual(["status"]);
        expect(entry?.reason).toContain("8-byte");
        expect(entry?.reason).toContain("prefix");
        // A digest is reported per side and only for a side whose bytes are
        // whole: the recorded body was cut at the session's limit, so it has
        // none, while the replayed one is complete and does. The absence is
        // what tells a caller that the two numbers they are looking at would
        // not have been a comparison of the same bytes.
        expect(entry?.recorded_body_digest).toBeUndefined();
        expect(entry?.observed_body_digest).not.toBeUndefined();
      });
    },
    TIMEOUT,
  );
});

describe("replaying somewhere else", () => {
  it(
    "keeps each recorded path, replaces the origin, and recomputes the host header",
    async () => {
      await withCapture({ max_exchanges: 10 }, async (capture) => {
        await through(capture, "/hello");
        await through(capture, "/headers");

        const output = await replay(capture, { target: elsewhere.origin });

        expect(output["target"]).toBe(elsewhere.origin);
        const entries = exchangesOf(output);
        // The recorded URL is left alone — it is what the exchange was — and
        // `replayed_url` is where this run actually sent it.
        for (const entry of entries) {
          expect(entry.url.startsWith(fixture.origin)).toBe(true);
          expect(entry.replayed_url.startsWith(elsewhere.origin)).toBe(true);
        }

        // `/hello` answers the same bytes from either origin, so it matches. The
        // headers echo does not: the target echoes the `host` it was sent, and a
        // replayed `host` would still name the origin the capture came from —
        // which would make the two bodies equal again. The difference is the
        // assertion.
        const hello = entries.find((entry) => entry.url.endsWith("/hello"));
        const headers = entries.find((entry) => entry.url.endsWith("/headers"));
        expect(hello?.outcome).toBe("matched");
        expect(headers?.outcome).toBe("differs");
        expect(headers?.observed_status).toBe(200);
      });
    },
    TIMEOUT,
  );
});

describe("the window a replay covers", () => {
  it(
    "takes the oldest exchanges first, so a larger limit is a superset",
    async () => {
      await withCapture({ max_exchanges: 10 }, async (capture) => {
        for (const path of ["/hello", "/healthz", "/headers"]) await through(capture, path);

        const first = await replay(capture, { limit: 1 });
        expect(first["replayed"]).toBe(1);
        expect(first["withheld_by_limit"]).toBe(2);

        const rest = await replay(capture, { since_id: exchangesOf(first)[0]?.exchange_id });
        expect(rest["replayed"]).toBe(2);

        const all = await replay(capture, { limit: 10 });
        expect(all["withheld_by_limit"]).toBe(0);
        expect(all["replayed"]).toBe(3);

        // The cursor and the limit select the same window `uvp_capture_read`
        // does, so the three runs above are prefixes of the same list.
        const ids = exchangesOf(all).map((entry) => entry.exchange_id);
        expect(ids.slice(0, 1)).toEqual(exchangesOf(first).map((entry) => entry.exchange_id));
        expect(ids.slice(1)).toEqual(exchangesOf(rest).map((entry) => entry.exchange_id));
      });
    },
    TIMEOUT,
  );

  it(
    "reports a cursor the session no longer holds instead of starting over",
    async () => {
      await withCapture({ max_exchanges: 10 }, async (capture) => {
        await through(capture, "/hello");

        const output = await replay(capture, {
          since_id: "exc_0000000000000000000000",
          limit: 10,
        });

        expect(output["since_id_unknown"]).toBe(true);
        expect(output["replayed"]).toBe(1);
      });
    },
    TIMEOUT,
  );
});

describe("a capture session that is not there", () => {
  it(
    "reports capture_not_found rather than an empty capture",
    async () => {
      // #49: the session lookup used to share `capture_unavailable` with a bind
      // failure. The two have different remedies, and this is the observable half
      // of the split: a caller that mistyped an id is told the session does not
      // exist, not that capture is unavailable.
      // A schema-valid id that no session holds. `does-not-exist` would be refused
      // by the input pattern before the lookup, which is a different claim.
      const code = await refusalCode("uvp_capture_read", {
        capture_id: "cap_0000000000000000000000",
      });
      expect(code).toBe("capture_not_found");
    },
    TIMEOUT,
  );
});
