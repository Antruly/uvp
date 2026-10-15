import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import { EXIT_OK } from "../../src/cli/exitCodes.js";
import type { OutputStreams } from "../../src/cli/output.js";
import { createToolHandlers, handlerFor } from "../../src/composition/toolHandlers.js";
import { createUvpServices } from "../../src/composition/uvpServices.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import type { ToolContract } from "../../src/contracts/toolContractTypes.js";
import { toUvpError } from "../../src/domain/errors.js";
import { startFixture } from "./fixtureServer.js";
import type { FixtureServer } from "./fixtureServer.js";

/**
 * How `uvp_http_request` behaves under the four conditions a debugging tool is
 * most likely to be believed about and most likely to be wrong about: a
 * redirect, a deadline, the clock, and the body it hands a caller as text.
 *
 * The contract lists `follow_redirects`, `max_redirects`, and `timeout_ms` as
 * inputs and `redirects` and `timing` as outputs; `handlers.test.ts` checks that
 * the shapes validate. Neither says the switches *do* anything. A client that
 * ignored all three would pass every test in this repository so far, because a
 * request that is never redirected, never times out, and whose timings nobody
 * reads looks exactly like a correct one.
 *
 * The four claims, and the failure each would otherwise hide:
 *
 * - **A redirect is reported, not followed, unless asked.** A tool that followed
 *   silently would hand back a 200 from a URL the caller never named and call it
 *   the exchange they asked about — the single most misleading answer this tool
 *   could give. Following is therefore opt-in, and every hop is listed.
 * - **Past `max_redirects` the client stops and reports.** Not an error: the last
 *   3xx is a real response the caller can act on, and a loop is a property of the
 *   server, so `redirects` showing the hops taken is the honest answer.
 * - **`timeout_ms` ends the request, and says so.** The distinction between "the
 *   endpoint refused the connection" and "the endpoint accepted it and said
 *   nothing" decides whether the caller raises a timeout or restarts a service,
 *   so the two must not collapse into one error code.
 * - **A body decoded as text says when the text is not the bytes.** Decoding is
 *   lossy when the peer's bytes are not UTF-8, and also when a cap cut a
 *   character in half — the first is a finding about the service and the second
 *   is the caller's own doing, so a caller told they are the same thing goes
 *   looking for a bug in a service that is fine. `text_lossy` names which, and
 *   the three answers are checked against a real socket rather than a table.
 *
 * `timing` is checked the same way. Timings are the field most easily fabricated
 * — anything nonzero satisfies a reader — so the assertion is against a delay
 * the *fixture* chose, which this process cannot influence: if `ttfb_ms` is
 * reported below the fixture's own sleep, the number did not come from a
 * measurement.
 */

const TIMEOUT = 30_000;

let fixture: FixtureServer;
let services: ReturnType<typeof createUvpServices>;
let handlers: ReturnType<typeof createToolHandlers>;
let signal: AbortSignal;

const call = async (input: unknown): Promise<Record<string, unknown>> =>
  await handlerFor(handlers, "uvp_http_request")(input, { signal });

/** The error code a refusal projects to at the adapter boundary. */
const refusalCode = async (input: unknown): Promise<string> => {
  try {
    await call(input);
  } catch (cause) {
    return toUvpError(cause).code;
  }
  throw new Error(`uvp_http_request was expected to refuse ${JSON.stringify(input)} and did not`);
};

/**
 * The result, checked against the contract that describes it.
 *
 * This lane exists because the contract is the single source of truth for every
 * adapter that reads it; a result the contract rejects is a result the MCP
 * server would hand to a client that cannot parse it.
 */
const conforming = async (input: unknown): Promise<Record<string, unknown>> => {
  const output = await call(input);
  const contract = toolContract("uvp_http_request") as ToolContract | undefined;
  if (contract === undefined) throw new Error("uvp_http_request is not a known contract");
  const parsed = contract.outputSchema.safeParse(output);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(`uvp_http_request produced output its own contract rejects:\n${issues}`);
  }
  return output;
};

beforeAll(async () => {
  fixture = await startFixture();
  services = createUvpServices();
  handlers = createToolHandlers(services);
  signal = new AbortController().signal;
});

afterAll(async () => {
  await fixture.stop();
});

describe("a redirect", () => {
  it(
    "is returned as the answer when following was not requested",
    async () => {
      const output = await conforming({ url: `${fixture.origin}/redirect` });

      // The 302 itself. The caller asked about `/redirect` and that is what the
      // server said; a client that resolved it first would be answering a
      // different question with a different URL and a different status.
      expect(output["status"]).toBe(302);
      expect(output["request"]).toEqual({ method: "GET", url: `${fixture.origin}/redirect` });
      expect((output["headers"] as Record<string, string>)["location"]).toBe("/hello");
      // Nothing was followed, so nothing is listed as having been.
      expect(output["redirects"]).toEqual([]);
      // The un-followed hop landed on no body, which is what the server sent —
      // not the greeting on the other side of the hop.
      expect((output["body"] as Record<string, unknown>)["bytes"]).toBe(0);
      expect(JSON.stringify(output)).not.toContain("Hello, AI");
    },
    TIMEOUT,
  );

  it(
    "is followed when asked, with every hop listed",
    async () => {
      const output = await conforming({
        url: `${fixture.origin}/redirect`,
        follow_redirects: true,
      });

      // The final response is the target's, and the body proves the client went
      // there rather than reporting a 302 under a different status.
      expect(output["status"]).toBe(200);
      expect((output["body"] as Record<string, unknown>)["text"]).toContain("Hello, AI");
      // The hop is reported rather than hidden: a caller reading `status: 200`
      // alone would not know the URL in `request` is not the one that answered.
      expect(output["redirects"]).toEqual([{ status: 302, location: "/hello" }]);
    },
    TIMEOUT,
  );

  it(
    "stops at max_redirects and reports the hops it took",
    async () => {
      const output = await conforming({
        url: `${fixture.origin}/redirect-loop`,
        follow_redirects: true,
        max_redirects: 2,
      });

      // A loop is the server's property, not a client failure. The caller gets
      // the last 3xx and the list of hops, which is what tells them it is a loop.
      expect(output["status"]).toBe(302);
      const redirects = output["redirects"] as { status: number; location: string }[];
      expect(redirects).toHaveLength(2);
      expect(redirects.every((hop) => hop.location === "/redirect-loop")).toBe(true);

      // The limit is a limit, not a suggestion: a third hop means the switch was
      // read and then ignored.
      const tighter = await conforming({
        url: `${fixture.origin}/redirect-loop`,
        follow_redirects: true,
        max_redirects: 0,
      });
      expect(tighter["status"]).toBe(302);
      expect(tighter["redirects"]).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("a request deadline", () => {
  it(
    "ends the request and is reported as a timeout, not as an unreachable endpoint",
    async () => {
      // `/slow` accepted the connection and then said nothing for 30s. That is
      // the case an operator acts on differently from a refused connection, so
      // the code has to distinguish them.
      const code = await refusalCode({
        url: `${fixture.origin}/slow`,
        timeout_ms: 300,
        follow_redirects: false,
      });
      expect(code).toBe("timeout");
    },
    TIMEOUT,
  );

  it(
    "leaves a connection refused as an unreachable endpoint",
    async () => {
      // The other half of the pair. Without it, a client that mapped every
      // failure to `timeout` would pass the test above.
      const closed = await refusalCode({
        url: `http://127.0.0.1:${String(fixture.port + 1)}/hello`,
        timeout_ms: 2_000,
      });
      expect(closed).toBe("endpoint_unreachable");
    },
    TIMEOUT,
  );
});

describe("the timing breakdown", () => {
  it(
    "measures the wait the fixture imposed rather than reporting a placeholder",
    async () => {
      const delayMs = 250;
      const output = await conforming({
        url: `${fixture.origin}/delayed?ms=${String(delayMs)}`,
      });

      const timing = output["timing"] as Record<string, number | undefined>;
      // The fixture slept before writing its first byte, and nothing in this
      // process can make that sleep shorter. A `ttfb_ms` below it is a number
      // that did not come from the exchange.
      expect(timing["ttfb_ms"]).toBeGreaterThanOrEqual(delayMs);
      expect(timing["total_ms"]).toBeGreaterThanOrEqual(delayMs);

      // Phases are ordered by when they happen. A connect that outlasts the
      // first byte, or a total below its own time-to-first-byte, is a breakdown
      // assembled rather than observed.
      expect(timing["total_ms"]).toBeGreaterThanOrEqual(timing["ttfb_ms"] ?? Number.NaN);
      if (timing["connect_ms"] !== undefined) {
        expect(timing["connect_ms"]).toBeGreaterThanOrEqual(0);
        expect(timing["connect_ms"]).toBeLessThanOrEqual(timing["ttfb_ms"] ?? Number.NaN);
      }
      if (timing["dns_ms"] !== undefined) {
        expect(timing["dns_ms"]).toBeGreaterThanOrEqual(0);
        expect(timing["dns_ms"]).toBeLessThanOrEqual(timing["ttfb_ms"] ?? Number.NaN);
      }
    },
    TIMEOUT,
  );

  it(
    "is not fabricated for a request that never completed",
    async () => {
      // Every tool here refuses to invent a status for an exchange that did not
      // happen. The failure carries the elapsed wall clock and nothing that
      // looks like a response, and — the half that is easy to lose — the session
      // records no exchange for it, so no later bundle cites a phantom one.
      const before = services.store.totalExchanges();
      const failure = await (async () => {
        try {
          await call({ url: `${fixture.origin}/slow`, timeout_ms: 300 });
        } catch (cause) {
          return toUvpError(cause);
        }
        throw new Error("uvp_http_request was expected to time out and did not");
      })();

      expect(failure.code).toBe("timeout");
      expect(failure.details).not.toHaveProperty("status");
      expect(services.store.totalExchanges()).toBe(before);

      // And the graph is still usable: a failure must not leave a half-written
      // record behind for the next call to append to.
      const after = await conforming({ url: `${fixture.origin}/hello` });
      expect(after["status"]).toBe(200);
      expect(services.store.totalExchanges()).toBe(before + 1);
    },
    TIMEOUT,
  );
});

describe("a body the text is not", () => {
  /** The `body` block of a result the contract already accepted. */
  const bodyOf = async (input: unknown): Promise<Record<string, unknown>> =>
    (await conforming(input))["body"] as Record<string, unknown>;

  // Written as a code point rather than as the character, because the point of
  // every assertion below is which character it is, and a replacement character
  // pasted into source is indistinguishable from one that arrived there by
  // accident.
  const replacement = String.fromCodePoint(0xff_fd);

  it(
    "says the text is not the bytes when the peer sent something that is not UTF-8",
    async () => {
      // This is the answer a caller comparing the text against `digest` would
      // otherwise find no explanation for: `ff fe` start no UTF-8 sequence, so
      // the decode lost them and the bytes that made it into the text are not the
      // bytes the peer sent.
      const body = await bodyOf({ url: `${fixture.origin}/not-utf8` });

      expect(body["truncated"]).toBe(false);
      expect(body["decoded_as_text"]).toBe(true);
      expect(body["text"]).toBe(`Hi${replacement.repeat(2)}!`);
      expect(body["text_lossy"]).toBe("invalid-utf8");

      // The difference the field exists to explain, made explicit: the digest is
      // over the bytes the fixture sent, and re-encoding the text does not
      // reproduce it. A caller comparing the two would otherwise have a mismatch
      // and nothing in the output to account for it.
      const sent = Buffer.from([0x48, 0x69, 0xff, 0xfe, 0x21]);
      const digest = (bytes: Uint8Array): string =>
        createHash("sha256").update(bytes).digest("hex");
      expect(body["digest"]).toBe(digest(sent));
      expect(digest(Buffer.from(body["text"] as string, "utf8"))).not.toBe(body["digest"]);

      // And the bytes themselves are not in this answer: a body decoded as text is
      // handed over as text and not also as base64, so `text_lossy` is the whole
      // of what a caller gets to know about the loss. The roadmap carries that as
      // its own question rather than this lane inventing an answer.
      expect(body["base64"]).toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "blames the cap, not the peer, when the cap cut a character in half",
    async () => {
      // Sixteen three-byte characters, capped at seven bytes: two whole
      // characters and one byte of the third. The peer sent nothing invalid, and
      // a tool that reported this as the service's doing would be sending a
      // caller to debug a service that is fine.
      const cut = await bodyOf({ url: `${fixture.origin}/multibyte`, max_body_bytes: 7 });

      expect(cut["truncated"]).toBe(true);
      expect(cut["text"]).toBe(`中中${replacement}`);
      expect(cut["text_lossy"]).toBe("truncated");
    },
    TIMEOUT,
  );

  it(
    "blames the peer, not a cap, when nothing cut a body that stops mid-character",
    async () => {
      // Seven bytes the peer chose to send: two whole characters and the first
      // byte of a third, with no cap in the way. Every byte of the loss is the
      // peer's, and a client that answered "truncated" here — the tempting
      // shortcut, since these are exactly the bytes a cap leaves — would send a
      // caller to look for a limit they never set.
      const half = await bodyOf({ url: `${fixture.origin}/half-character` });

      expect(half["truncated"]).toBe(false);
      expect(half["bytes"]).toBe(7);
      expect(half["text"]).toBe(`中中${replacement}`);
      expect(half["text_lossy"]).toBe("invalid-utf8");
    },
    TIMEOUT,
  );

  it(
    "says nothing when a cap landed between two characters",
    async () => {
      // The same body capped at six bytes: two whole characters and nothing
      // partial. There is no loss to report, and this is the case that makes
      // "refuse to call a re-encode-different body text" the wrong fix — that
      // rule would turn every truncated multi-byte body into base64 with the peer
      // having done nothing at all.
      const between = await bodyOf({ url: `${fixture.origin}/multibyte`, max_body_bytes: 6 });

      expect(between["truncated"]).toBe(true);
      expect(between["text"]).toBe("中中");
      expect(between["text_lossy"]).toBeUndefined();
      // And the text is the bytes that were kept, which is the property the field
      // exists to certify.
      expect(Buffer.from(between["text"] as string, "utf8").byteLength).toBe(6);
    },
    TIMEOUT,
  );

  it(
    "renders the same distinction for a person, above the text it is about",
    async () => {
      // The rendering, not only the JSON: this is the surface where a lossy decode
      // is most likely to be read as the response, because a terminal shows the
      // text and nothing else. Asserted in both directions, since a line that
      // appeared on every body — or on none — would be worse than no line.
      const rendered = async (args: string[]): Promise<{ exit: number; text: string }> => {
        const written: string[] = [];
        const streams: OutputStreams = {
          out: (text) => written.push(text),
          err: (text) => written.push(text),
        };
        const exit = await runCli(args, { streams, services });
        return { exit, text: written.join("\n") };
      };

      const lossy = await rendered(["http", `${fixture.origin}/not-utf8`, "--max-bytes", "8"]);
      expect(lossy.exit).toBe(EXIT_OK);
      expect(lossy.text).toMatch(/^\s+text is a lossy decode: the peer sent bytes.*$/mu);
      // Above the text, so it is read before the response is taken at face value.
      expect(lossy.text.indexOf("text is a lossy decode")).toBeLessThan(lossy.text.indexOf("Hi"));

      const whole = await rendered(["http", `${fixture.origin}/multibyte`, "--max-bytes", "6"]);
      expect(whole.exit).toBe(EXIT_OK);
      expect(whole.text).not.toContain("lossy");
    },
    TIMEOUT,
  );
});
