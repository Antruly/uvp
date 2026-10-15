import { createServer } from "node:http";
import type { Server } from "node:http";

import { afterAll, describe, expect, it } from "vitest";

import { EXIT_NO, EXIT_OK, EXIT_WRONG } from "../../src/cli/exitCodes.js";
import { parseUvpError } from "../../src/domain/errors.js";
import {
  buildWorkspace,
  cleanup,
  createWorkspace,
  realLibuvcpp,
  resultOrThrow,
  runCli,
  skipReason,
} from "../support/realLibuvcpp.js";
import type { CliOutcome, Workspace } from "../support/realLibuvcpp.js";
import { listOf } from "./verifyBundle.js";
import type { Exchange } from "./verifyBundle.js";

/**
 * HTTP/2, from the feature a workspace declares to the protocol a probe observes.
 *
 * `src/application/templates.test.ts` proves the shorter half — that asking for
 * the `http2` module puts `set_h2c_enabled(true)` into the generated source. That
 * is a claim about a string. This file is the claim about the wire, and it is the
 * one the roadmap row means by "end to end": a workspace generated with
 * `--features http2` is built by a real compiler against a real libuvcpp, started,
 * and asked for a response over HTTP/2 — and then asked, on the same port and
 * without restarting anything, for one over HTTP/1.1.
 *
 * ## Why the assertion is the interesting part
 *
 * A service that answers HTTP/1.1 whatever it is sent will happily satisfy
 * `status=200`. So the check that makes this file worth running is
 * `http_version=2.0`, which reads the version the response **arrived in** — a
 * field the probe records from the wire and the caller's `--http-version` cannot
 * supply, because that one names what to *attempt*. The teeth are pinned rather
 * than assumed: the same assertion is run where it must pass (`--http-version 2`)
 * and where it must fail (`auto`, which negotiates down to 1.1), and the failing
 * one is required to say `1.1` rather than merely to be red.
 *
 * ## What is deliberately not here
 *
 * HTTP/3. The transport exists — the `http3-service` template serves it, and
 * `tests/toolchain/nativeProbe.test.ts` completes an exchange over QUIC against a
 * built one — but this lane's fixture is a `hello-http` workspace, so the question
 * `--http-version 3` is asked against is an `http://` URL and the answer is a
 * refusal. What is pinned below is that refusal: `invalid_request`, by name,
 * naming `https://`, rather than an answer sent over HTTP/1.1 and reported as the
 * version the caller asked for. The transport itself is covered where it can be
 * answered.
 *
 * The install this lane runs against must also have been built with nghttp2. That
 * is not assumed: `set_h2c_enabled` is a no-op without it, `http2_enabled()`
 * reports false, and the first test below would fail with `1.1` in the message —
 * which is the correct report for an install that cannot do this, not a flake.
 */

/** This file's port. Disjoint from `manualPath`'s 8321 and `verifyClosure`'s 8301. */
const PORT = 8322;

/**
 * The workspace every pass below runs against, generated once with the feature.
 *
 * The feature is the whole point: the same template without `--features http2`
 * serves HTTP/1.1 only, and the third test below is the one that keeps this file
 * from passing against it — an `http_version=2.0` assertion that cannot fail
 * would make everything above it decoration.
 */
let made: Promise<Workspace> | undefined;
const workspace = (): Promise<Workspace> =>
  (made ??= createWorkspace("hello-http", PORT, ["http2"]));

/** One `uvp verify` pass over that workspace. The caller judges the outcome. */
const verify = async (args: readonly string[]): Promise<CliOutcome> =>
  await runCli(["verify", (await workspace()).root, ...args, "--json"]);

/** The two requests, as flags: one pinned to HTTP/2, one left to negotiate. */
const H2_REQUEST: readonly string[] = [
  "--request",
  "GET",
  "/hello",
  "--http-version",
  "2",
  "--assert",
  "status=200",
  "--assert",
  "http_version=2.0",
];

const AUTO_REQUEST: readonly string[] = ["--request", "GET", "/hello", "--assert", "status=200"];

/** The exchanges of a bundle, keyed by the version each one arrived in. */
const versionsOf = (result: Record<string, unknown>): readonly unknown[] =>
  listOf<Exchange>(result, "exchanges").map((entry) => entry.http_version);

/**
 * Whether the libuvcpp on this host can serve HTTP/2 at all.
 *
 * Asked of the module list `uvp doctor` read out of `uvcpp_config.h`, which is
 * the owning boundary's parsed fact, rather than inferred from the version
 * number. libuvcpp can be built with `UVCPP_ENABLE_NGHTTP2=OFF` and still call
 * itself 1.7.0; on such an install `set_h2c_enabled` is a documented no-op and
 * `http2_enabled()` honestly returns false. A lane that ran anyway would fail
 * here with `1.1` in a message about an assertion, which reads as a defect in the
 * service rather than as a library that was built without the module — so it
 * names the absence instead.
 */
const h2Serving: boolean = realLibuvcpp?.modules.includes("UVCPP_NGHTTP2_ENABLE") ?? false;

/**
 * Why the three service tests below do not run here. Empty when they do.
 *
 * The two tests after them need none of this: uvp's HTTP/2 client is Node's, and
 * the protocol-mismatch classification is about the words in a refusal.
 */
const skipServing: string =
  realLibuvcpp === undefined
    ? skipReason
    : h2Serving
      ? ""
      : `libuvcpp ${realLibuvcpp.version} at ${realLibuvcpp.prefix} was built without nghttp2 ` +
        `(UVCPP_NGHTTP2_ENABLE is not 1 in its uvcpp_config.h), so a generated service ` +
        `cannot serve HTTP/2 at all`;

const describeServing = describe.skipIf(!h2Serving);
const describeRefusals = describe.skipIf(realLibuvcpp === undefined);

describeServing(
  h2Serving
    ? `HTTP/2 end to end, on real CMake and libuvcpp ${String(realLibuvcpp?.version)}`
    : `HTTP/2 end to end — skipped: ${skipServing}`,
  () => {
    it(
      "answers over HTTP/2 in cleartext, and the version is what the assertion reads",
      async () => {
        const target = await workspace();

        // Built first and separately, so a compile failure is reported as one.
        // `uvp verify` builds too, and inside it a broken workspace and a broken
        // assertion produce the same red bundle.
        const build = await buildWorkspace(target);
        expect(build.exit, build.stderr.slice(-2_000) || build.stdout.slice(0, 2_000)).toBe(
          EXIT_OK,
        );

        const outcome = await verify(["--port", String(PORT), ...H2_REQUEST]);
        expect(outcome.exit, outcome.stderr || outcome.stdout.slice(0, 400)).toBe(EXIT_OK);
        const result = resultOrThrow(outcome);
        expect(result["status"]).toBe("verified");

        const [exchange] = listOf<Exchange>(result, "exchanges");
        expect(exchange?.status).toBe(200);
        // The observation the assertion was about, in the bundle rather than only
        // in the exit code: a report of an HTTP/2 verification that does not say
        // which protocol answered cannot be read for the thing it was about.
        expect(exchange?.http_version).toBe("2.0");
        expect(exchange?.assertions_failed).toBe(0);
        expect(exchange?.failures).toEqual([]);
      },
      // A cold CMake configure and a compile of the template, inside this test.
      120_000,
    );

    it("serves both protocols on one port in one service lifetime", async () => {
      // h1 and h2c share the port and are told apart by the 24-byte connection
      // preface RFC 9113 defines — no second port, no `Upgrade` handshake, which
      // RFC 9113 deleted. That is a claim about a *running* service, so it is
      // made the only way it can be: two requests in one pass, one pinned and
      // one negotiating, against one launch. Two passes would leave open the
      // possibility that each protocol only works on a service started for it.
      const outcome = await verify([
        "--port",
        String(PORT),
        ...H2_REQUEST,
        // Deliberately the same method and path: if the two exchanges were
        // told apart by anything but the protocol, this would be measuring the
        // route rather than the transport.
        ...AUTO_REQUEST,
        "--assert",
        "http_version=1.1",
      ]);

      expect(outcome.exit, outcome.stderr || outcome.stdout.slice(0, 400)).toBe(EXIT_OK);
      const result = resultOrThrow(outcome);
      expect(result["status"]).toBe("verified");
      expect(versionsOf(result)).toEqual(["2.0", "1.1"]);
      // One endpoint, because it was one launch. A pass that had started two
      // services would report whichever it started last.
      const service = result["service"] as Record<string, unknown>;
      expect(service["ready"]).toBe(true);
      expect(String(service["endpoint"])).toContain(String(PORT));
    }, 120_000);

    it("fails the version assertion when the service was asked to negotiate", async () => {
      // The negative control for the first two tests, and the reason they are
      // evidence. `auto` negotiates down to HTTP/1.1 — which is a *success*, not
      // an error — so a pass that pinned `http_version=2.0` while letting the
      // client choose must fail, and must say which version it saw. Without
      // this, an evaluator that answered `passed: true` whenever there was any
      // response would satisfy every assertion above.
      const outcome = await verify([
        "--port",
        String(PORT),
        ...AUTO_REQUEST,
        "--assert",
        "http_version=2.0",
      ]);

      // Exit 1, not 2, and the difference is the point: the pass ran, uvp put
      // the question to the service and got an answer, and the answer was no.
      // Exit 2 would mean uvp could not ask.
      expect(outcome.exit).toBe(EXIT_NO);
      const result = resultOrThrow(outcome);
      expect(result["status"]).toBe("failed");
      const [exchange] = listOf<Exchange>(result, "exchanges");
      // Recorded, not inferred: the response did arrive, over the version the
      // client fell back to, and that is a different record from no response.
      expect(exchange?.http_version).toBe("1.1");
      expect(exchange?.status).toBe(200);
      expect(exchange?.assertions_failed).toBe(1);
      const failures = listOf<string>(exchange as unknown as Record<string, unknown>, "failures");
      expect(failures.join(" ")).toContain("1.1");
      expect(failures.join(" ")).toContain("2.0");
    }, 120_000);

    it("refuses HTTP/3 over a cleartext workspace rather than answering it over HTTP/1.1", async () => {
      // A refusal rather than a silent downgrade, and this is the refusal a
      // `uvp verify --http-version 3` actually meets: the pass builds its URL
      // from the workspace's scheme, `hello-http` is cleartext, and QUIC has no
      // cleartext mode. The code is `invalid_request` and the message names
      // `https://`, because the part that is wrong is the request.
      //
      // The other two ways this can end are deliberately not exercised here,
      // because neither is about HTTP/3: a TLS workspace reaches libuvcpp's QUIC
      // client in a separate probe process, which is `toolchain_unavailable` on a
      // host without the probe binary. `tests/toolchain/nativeProbe.test.ts` is
      // where that client is actually asked, against a real `http3-service`.
      //
      // It sits in this describe rather than the next one because it goes through
      // `uvp verify`, which builds before it asks: the workspace declares the
      // `http2` module and so only compiles where nghttp2 is present. The fact
      // under test needs no HTTP/2, but the fixture does.
      const outcome = await verify([
        "--port",
        String(PORT),
        "--request",
        "GET",
        "/hello",
        "--http-version",
        "3",
        "--assert",
        "status=200",
      ]);

      // Exit 2 — uvp could not put the question — and the failure is uvp's own,
      // so the bundle still reports the exchange as never having happened.
      expect(outcome.exit).toBe(EXIT_WRONG);
      const result = resultOrThrow(outcome);
      const exchange = listOf<Exchange>(result, "exchanges")[0];
      expect(exchange?.status).toBeUndefined();
      expect(exchange?.http_version).toBeUndefined();
      const unverified = listOf<{ readonly reason?: unknown; readonly question?: unknown }>(
        result,
        "unverified",
      );
      expect(unverified.map((entry) => String(entry.reason)).join(" ")).toMatch(/HTTP\/3|http3/iu);
    });
  },
);

describeRefusals(
  realLibuvcpp === undefined
    ? `how uvp reports a version it cannot speak — skipped: ${skipReason}`
    : `how uvp reports a version it cannot speak, on libuvcpp ${realLibuvcpp.version}`,
  () => {
    it("reports a pinned version the peer does not speak as a protocol mismatch, not a dead host", async () => {
      // The failure a caller is most likely to meet, and the one whose message
      // matters most: asking for HTTP/2 with prior knowledge against a service
      // that only speaks HTTP/1.1. The service is *listening* — it answered, in a
      // protocol this client could not read — so `endpoint_unreachable` with
      // "check that the service is listening on that host and port" would send the
      // caller to inspect the one thing that is working, and `retryable: true`
      // would have them do it again.
      //
      // The peer is a plain Node HTTP/1.1 server rather than a second generated
      // workspace: the fact under test is uvp's classification of a mismatch, and
      // it takes no C++ to produce an HTTP/1.1 peer. It is still a real socket and
      // a real response, which is what makes this an observation.
      const peer: Server = createServer((_, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"message":"Hello, AI"}');
      });
      await new Promise<void>((resolve) => {
        peer.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = peer.address();
        if (address === null || typeof address === "string") {
          throw new Error("the HTTP/1.1 peer did not report a port");
        }
        const url = `http://127.0.0.1:${String(address.port)}/hello`;

        const refused = await runCli(["http", url, "--http-version", "2", "--json"]);
        expect(refused.exit).toBe(EXIT_WRONG);
        expect(refused.stdout.trim()).toBe("");
        const error = parseUvpError(JSON.parse(refused.stderr) as unknown);
        expect(error.code).toBe("unsupported_target");
        // Not a transient condition, so no caller should loop on it.
        expect(error.retryable).toBe(false);
        expect(error.remediation.action).toMatch(/http2|http\/2/iu);
        expect(error.remediation.action).not.toMatch(/listening on that host/iu);
        expect(String(error.details?.["requested_http_version"])).toBe("2");

        // And the same peer answers when it is asked in the protocol it speaks,
        // so the refusal above is about the version and not about the endpoint.
        const accepted = await runCli(["http", url, "--http-version", "1.1", "--json"]);
        expect(accepted.exit, accepted.stderr).toBe(EXIT_OK);
        const answered = resultOrThrow(accepted);
        expect(answered["status"]).toBe(200);
        expect(answered["http_version"]).toBe("1.1");
      } finally {
        await new Promise<void>((resolve) => {
          peer.close(() => {
            resolve();
          });
        });
      }
    });
  },
);

afterAll(() => {
  cleanup();
});
