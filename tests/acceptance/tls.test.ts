import { afterAll, describe, expect, it } from "vitest";

import { EXIT_OK, EXIT_WRONG } from "../../src/cli/exitCodes.js";
import { parseUvpError } from "../../src/domain/errors.js";
import {
  buildWorkspace,
  cleanup,
  createWorkspace,
  portIsFree,
  realLibuvcpp,
  resultOrThrow,
  runCli,
  runToExit,
  skipReason,
  startService,
} from "../support/realLibuvcpp.js";
import type { CliOutcome, Workspace } from "../support/realLibuvcpp.js";
import { certificates, opensslSkipReason } from "../support/tlsCertificates.js";
import type { TlsCertificateStore } from "../support/tlsCertificates.js";
import { listOf, onlyExchange } from "./verifyBundle.js";

/**
 * TLS, from the certificate a generated service is handed to the one a caller reads back.
 *
 * `src/application/templates.test.ts` proves the shorter half: that declaring the
 * `tls` module puts `enable_ssl` and a refusal path into the generated source.
 * That is a claim about a string. This file is the claim about the wire, made the
 * only way it can be: a workspace generated with `--features tls` is compiled by
 * a real compiler against a real libuvcpp, handed a real certificate minted by
 * `openssl`, started, and asked over a real socket. Then it is handed a *wrong*
 * one, and the assertion is that it stops rather than serves.
 *
 * ## The failure that makes this lane worth its minutes
 *
 * A service that declared TLS and came up in cleartext is invisible from the
 * caller's side: the request succeeds, the response is correct, and nothing in
 * the bundle says the traffic was readable. libuvcpp marks such an app
 * TLS-unavailable so `start()` returns `UV_EINVAL` — its header calls silent
 * cleartext "这里最坏的失败模式" — and the generated main refuses before
 * `start()`. Both halves of that are observed here: the exit code and the message
 * are asserted, and so is the fact that **nothing is listening** afterwards,
 * because a refusal that left a listener on the port would be a service serving
 * something.
 *
 * ## What is deliberately not here
 *
 * HTTP/2 over TLS. The ALPN leg is libuvcpp's and the tests above it are about
 * `uvp`'s client, so a pass here would be asserting a negotiation this lane does
 * not configure. What this lane pins is the certificate: which one is served,
 * which ones are refused, and which of those refusals a pass reports as a verdict
 * rather than as a note.
 */

/** This file's port. Disjoint from `manualPath`'s 8321, `verifyClosure`'s 8301, `http2`'s 8322. */
const PORT = 8331;

/** The two environment variables a generated `tls` workspace reads. */
const certEnv = (cert: string, key: string): Record<string, string> => ({
  UVP_TLS_CERT: cert,
  UVP_TLS_KEY: key,
});

/**
 * The workspace every test below runs against, generated once with the feature.
 *
 * Built in its own right rather than inside a `uvp verify` pass, because four of
 * the tests below start the binary directly — the refusals cannot be observed
 * through a pass that builds first and reports one bundle for everything.
 */
let made: Promise<Workspace> | undefined;
const workspace = (): Promise<Workspace> => (made ??= createWorkspace("hello-http", PORT, ["tls"]));

/** One `uvp verify` pass over that workspace, with the environment it needs. */
const verify = async (
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<CliOutcome> =>
  await runCli(["verify", (await workspace()).root, "--port", String(PORT), ...args, "--json"], {
    env,
  });

/** The certificates, minted once. `undefined` only where `openssl` is absent. */
const minted: TlsCertificateStore | undefined = await certificates();

/**
 * Why none of this ran, in the words of the observation that produced it.
 *
 * Three separate pieces, and each is named rather than folded into one skip
 * message: `openssl` mints the certificates, the module list says whether
 * libuvcpp was configured with OpenSSL at all — a workspace declaring `tls`
 * against an install without it fails its own `#error` guard, which would read as
 * a broken template rather than as a library built without the module — and the
 * install is the thing under test. A lane that ran anyway would report uvp's
 * health as a fact about the host, which is the failure mode the skip exists to
 * avoid.
 */
const skipTls: string =
  realLibuvcpp === undefined
    ? skipReason
    : minted === undefined
      ? opensslSkipReason
      : realLibuvcpp.modules.includes("UVCPP_OPENSSL_ENABLE")
        ? ""
        : `libuvcpp ${realLibuvcpp.version} at ${realLibuvcpp.prefix} was built without OpenSSL ` +
          `(UVCPP_OPENSSL_ENABLE is not 1 in its uvcpp_config.h), so a workspace declaring the ` +
          `tls module cannot be compiled at all`;

const describeTls = describe.skipIf(skipTls !== "");

/** The store, for the tests that only run where one was minted. */
const certs = (): TlsCertificateStore => minted as TlsCertificateStore;

/** `https://127.0.0.1:PORT/<path>`, the URL every probe here uses. */
const url = (path: string): string => `https://127.0.0.1:${String(PORT)}${path}`;

describeTls(
  skipTls === ""
    ? `TLS end to end, on real CMake and libuvcpp ${String(realLibuvcpp?.version)}`
    : `TLS end to end — skipped: ${skipTls}`,
  () => {
    it(
      "serves the certificate it was handed, and only a caller told to trust it accepts it",
      async () => {
        const target = await workspace();

        // Built first and separately: a compile failure is a different finding
        // from a certificate failure, and inside a verify pass the two arrive as
        // one red bundle.
        const build = await buildWorkspace(target);
        expect(build.exit, build.stderr.slice(-2_000) || build.stdout.slice(0, 2_000)).toBe(
          EXIT_OK,
        );

        const service = await startService(target, {
          env: certEnv(certs().paths.leaf, certs().paths.leafKey),
        });
        try {
          // What the service said it was doing, which is the only place the path
          // it read is written down. Without it a service that ignored the
          // variables entirely and generated its own certificate would pass the
          // positive case below for the wrong reason.
          expect(service.output()).toContain(certs().paths.leaf);

          const trusted = await runCli(["http", url("/hello"), "--json"], {
            env: { NODE_EXTRA_CA_CERTS: certs().caPath },
          });
          expect(trusted.exit, trusted.stderr || trusted.stdout.slice(0, 400)).toBe(EXIT_OK);
          const answer = resultOrThrow(trusted);
          expect(answer["status"]).toBe(200);
          const tls = answer["tls"] as Record<string, unknown> | undefined;
          expect(tls?.verification).toBe("verified");
          // The two names are what identify *which* certificate this was: the
          // leaf's subject and the CA that signed it. A service that generated
          // its own certificate would report `localhost` for the subject and
          // `localhost` for the issuer, which is the shape asserted below in the
          // self-signed test.
          expect(tls?.subject).toBe("localhost");
          expect(tls?.issuer).toBe("uvp-test-ca");
          expect(tls?.reason).toBeUndefined();

          // The negative control, and the reason the pass above is evidence: the
          // same URL, the same service, one process over, and a client that was
          // never told about the CA must refuse it. Without this, a workspace
          // that served a certificate Node already trusted — or none at all —
          // would satisfy every assertion above.
          const untrusted = await runCli(["http", url("/hello"), "--json"]);
          expect(untrusted.exit).toBe(EXIT_WRONG);
          const refusal = parseUvpError(JSON.parse(untrusted.stderr) as unknown);
          expect(refusal.code).toBe("target_unavailable");
          expect(refusal.details?.["reason_code"]).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
        } finally {
          await service.stop();
        }
      },
      // A cold CMake configure and a compile of the template, inside this test.
      120_000,
    );

    it("comes up on a self-signed certificate when it was handed no pair", async () => {
      // The fallback exists so a freshly generated workspace runs at all, and it
      // has to be *visible*: an operator who deploys this and finds that every
      // client refuses it needs the service to have said so, and to have said
      // what to set instead. libuvcpp documents `enable_self_signed` as for tests
      // and controlled intranets, so a silent fallback would be a generated
      // service quietly claiming a guarantee nobody made.
      const service = await startService(await workspace());
      try {
        const banner = service.output();
        expect(banner).toContain("self-signed");
        expect(banner).toContain("UVP_TLS_CERT");

        // Unchecked, and the reason is reported: this is the exchange `uvp http
        // --no-tls` is for, and a caller who turned checking off has still been
        // told what the check would have said.
        const lax = await runCli(["http", url("/hello"), "--no-tls", "--json"]);
        expect(lax.exit, lax.stderr).toBe(EXIT_OK);
        const answer = resultOrThrow(lax);
        expect(answer["status"]).toBe(200);
        const tls = answer["tls"] as Record<string, unknown> | undefined;
        expect(tls?.verification).toBe("not_checked");
        expect(tls?.reason).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");

        // The same service, asked the same question without the flag, is refused
        // rather than answered — which is what makes the flag a decision rather
        // than a workaround.
        const strict = await runCli(["http", url("/hello"), "--json"]);
        expect(strict.exit).toBe(EXIT_WRONG);
        const refusal = parseUvpError(JSON.parse(strict.stderr) as unknown);
        expect(refusal.retryable).toBe(false);
        expect(refusal.details?.["reason_code"]).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
      } finally {
        await service.stop();
      }
    });

    it("refuses to start when it was handed half a pair", async () => {
      // Neither reading is available: the missing half could be the other half of
      // a real certificate or of the self-signed fallback, and only one of them
      // is what the operator meant. So it stops, names the variable that is
      // missing, and leaves nothing listening.
      const outcome = await runToExit(await workspace(), {
        env: { UVP_TLS_CERT: certs().paths.leaf },
      });
      expect(outcome.code).not.toBe(0);
      expect(outcome.output).toContain("UVP_TLS_KEY");
      expect(await portIsFree(PORT)).toBe(true);
    });

    it("refuses to start rather than serve cleartext when the pair does not match", async () => {
      // The failure this lane exists for. libuvcpp reads and validates the pair
      // where `enable_ssl` is called and marks the app TLS-unavailable, so
      // `start()` would fail — but a service that reached `start()` and printed
      // an error next to a running server would be serving plaintext to a caller
      // who asked for HTTPS, which looks protected from their side and is not.
      // Both halves are asserted: the exit, the reason with the file in it, and
      // the empty port.
      const outcome = await runToExit(await workspace(), {
        env: certEnv(certs().paths.leaf, certs().paths.otherKey),
      });
      expect(outcome.code).not.toBe(0);
      expect(outcome.output).toContain("TLS is unusable");
      // libuvcpp's own reason, carried through `ssl_error()`: the file it could
      // not use and OpenSSL's message about why.
      expect(outcome.output).toContain(certs().paths.otherKey);
      expect(outcome.output).toMatch(/key values mismatch|no start line|PEM/iu);
      expect(await portIsFree(PORT)).toBe(true);
    });

    it("reports the certificate on a pass, and makes it a verdict only when asked", async () => {
      // `uvp verify` against the self-signed default, which is what the
      // workspace it just generated serves. Both directions are asserted,
      // because either one alone is satisfied by a flag that does nothing:
      // the default has to pass *and* say what it did not check, and `--tls`
      // has to fail on the same service.
      const lax = await verify(["--request", "GET", "/hello", "--assert", "status=200"]);
      expect(lax.exit, lax.stderr || lax.stdout.slice(0, 400)).toBe(EXIT_OK);
      const reported = resultOrThrow(lax);
      expect(reported["status"]).toBe("verified");
      const exchange = onlyExchange(reported);
      expect(exchange.status).toBe(200);
      // Both fields, together. `not_checked` without the reason reads as a pass
      // that did not look, when it looked and did not act on what it saw.
      expect(exchange.tls_verification).toBe("not_checked");
      expect(exchange.tls_reason).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");

      const strict = await verify([
        "--request",
        "GET",
        "/hello",
        "--assert",
        "status=200",
        "--tls",
      ]);
      // Exit 2 and `unknown`, not exit 1 and `failed`: the request never
      // completed, so no assertion was evaluated, and `failed` would claim a
      // verdict about a service uvp could not ask. The distinction is the
      // whole point of the status vocabulary.
      expect(strict.exit).toBe(EXIT_WRONG);
      const refused = resultOrThrow(strict);
      expect(refused["status"]).toBe("unknown");
      const unanswered = onlyExchange(refused);
      expect(unanswered.status).toBeUndefined();
      // No certificate fields on an exchange that did not happen: `not_checked`
      // here would be a claim about a certificate nothing observed.
      expect(unanswered.tls_verification).toBeUndefined();
      const unverified = listOf<{ readonly reason?: unknown }>(refused, "unverified");
      expect(unverified.map((entry) => String(entry.reason)).join(" ")).toContain(
        "DEPTH_ZERO_SELF_SIGNED_CERT",
      );
    }, 120_000);

    it("verifies a chain the caller was told to trust, with the flag that demands it", async () => {
      // The positive control for `--tls` above. Without it, a pass that failed
      // every certificate would satisfy that test, and `--tls` would be a flag
      // that only ever says no. The trust store is the process's:
      // `NODE_EXTRA_CA_CERTS` is read once at startup, so it is handed to the
      // spawned `uvp` rather than re-read here — and `uvp` passes its own
      // environment on to the service it starts, which is how the certificate
      // under test reaches the binary.
      const outcome = await verify(
        ["--request", "GET", "/hello", "--assert", "status=200", "--tls"],
        {
          ...certEnv(certs().paths.leaf, certs().paths.leafKey),
          NODE_EXTRA_CA_CERTS: certs().caPath,
        },
      );
      expect(outcome.exit, outcome.stderr || outcome.stdout.slice(0, 400)).toBe(EXIT_OK);
      const result = resultOrThrow(outcome);
      expect(result["status"]).toBe("verified");
      const exchange = onlyExchange(result);
      expect(exchange.status).toBe(200);
      expect(exchange.tls_verification).toBe("verified");
      // Present in the bundle rather than assumed: an exchange that was checked
      // and found good has no reason to give, and a field that was simply never
      // written would look the same.
      expect(exchange.tls_reason).toBeUndefined();
      expect(result["unverified"]).toEqual([]);
    }, 120_000);
  },
);

afterAll(() => {
  cleanup();
});
