import { execFile } from "node:child_process";
import { createServer } from "node:https";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { Server } from "node:https";

import { afterAll, describe, expect, it } from "vitest";

import { EXIT_OK, EXIT_WRONG } from "../../../src/cli/exitCodes.js";
import { parseUvpError } from "../../../src/domain/errors.js";
import {
  certificates,
  opensslAvailable,
  opensslSkipReason,
} from "../../support/tlsCertificates.js";
import type { TlsCertificate, TlsCertificateStore } from "../../support/tlsCertificates.js";

/**
 * What a caller of the published `uvp` learns about a TLS peer.
 *
 * Three things can only be observed from a process, and each one is a promise
 * the tool makes to whoever is running it:
 *
 * - **A chain that verifies is reported as verified.** `NODE_EXTRA_CA_CERTS` is
 *   read once, at startup, so trusting the CA means starting a process with the
 *   path in its environment. That is what makes this the only lane where
 *   `verification: "verified"` can be seen at all — and it is the control that
 *   keeps the rejections in `tests/boundary/tls.test.ts` from being satisfied by
 *   a client that simply refuses every certificate.
 * - **A name that does not match is the failure, when the issuer is trusted.**
 *   OpenSSL validates the chain before it looks at the name, so this shape is
 *   unreachable in a process that cannot be handed a CA. Here it can: a valid
 *   certificate for `other.test`, presented while the caller connects to
 *   `127.0.0.1`, fails as `ERR_TLS_CERT_ALTNAME_INVALID` and nothing else.
 * - **`--no-tls` does what it says, and its absence does what the failure
 *   contract says.** The flag was declared, documented in the usage line, and
 *   never read — `uvp http --no-tls` against a self-signed service failed with
 *   the same `endpoint_unreachable` it would have without the flag. The pair
 *   below is the test that fails without the fix: the same request, one flag
 *   apart, exiting 0 and 2.
 *
 * Nothing here builds or launches anything; the peers are three-script Node
 * servers on loopback ports, and every certificate is minted at run time.
 */

const promisified = promisify(execFile);

const REPOSITORY = resolve(import.meta.dirname, "..", "..", "..");
const UVP = join(REPOSITORY, "scripts", "uvp.mjs");

const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const certs: TlsCertificateStore | undefined = await certificates();

/** The minted set. Every test below is skipped when there is none. */
const minted = (): TlsCertificateStore => {
  if (certs === undefined) throw new Error(opensslSkipReason);
  return certs;
};

const servers: Server[] = [];

afterAll(() => {
  for (const server of servers) server.close();
});

/** An HTTPS peer on a loopback port, answering `ok`. */
const serveHttps = async (certificate: TlsCertificate): Promise<number> => {
  const server = createServer({ cert: certificate.cert, key: certificate.key }, (_, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  servers.push(server);
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
};

interface Invocation {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the published entry point, with the CA in its environment when asked.
 *
 * A child rather than `runCli`, because the environment is the thing under test:
 * `NODE_EXTRA_CA_CERTS` is read once, when the process starts, so a caller that
 * wants this client to trust a private CA has exactly one way to say so — and
 * whether that way works is a fact about the shipped bin script.
 */
const invoke = async (args: readonly string[], caPath?: string): Promise<Invocation> => {
  const env = caPath === undefined ? process.env : { ...process.env, NODE_EXTRA_CA_CERTS: caPath };
  try {
    const { stdout, stderr } = await promisified(process.execPath, [UVP, ...args], {
      cwd: REPOSITORY,
      env,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { exit: EXIT_OK, stdout, stderr };
  } catch (cause) {
    const failure = cause as { code?: unknown; stdout?: string; stderr?: string; message: string };
    if (typeof failure.code !== "number") {
      throw new Error(`uvp ${args.join(" ")} did not exit: ${failure.message}`);
    }
    return { exit: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

/** The http result object a successful call prints, verbatim on stdout. */
const resultOf = (invocation: Invocation, where: string): Record<string, unknown> => {
  expect(invocation.stderr.trim(), where).toBe("");
  expect(invocation.exit, where).toBe(EXIT_OK);
  const parsed: unknown = JSON.parse(invocation.stdout);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${where}: not an object`);
  return parsed as Record<string, unknown>;
};

const tlsOf = (invocation: Invocation, where: string): Record<string, unknown> => {
  const tls = resultOf(invocation, where)["tls"];
  if (typeof tls !== "object" || tls === null) throw new Error(`${where}: no tls in the result`);
  return tls as Record<string, unknown>;
};

const describeWithCertificates = describe.skipIf(!opensslAvailable);

describeWithCertificates(
  opensslAvailable
    ? "the certificate, as the published CLI reports it"
    : `the certificate, as the published CLI reports it — skipped: ${opensslSkipReason}`,
  () => {
    it("reports a verified chain when it was handed the CA that signed it", async () => {
      // The control the whole file exists for. Every rejection elsewhere is
      // satisfied by a client that rejects everything; this is the one that says
      // the client is reading the chain rather than the connection.
      //
      // The name matters: the certificate is issued for `localhost`, so the
      // request goes to the name it was issued for. Reaching it by `127.0.0.1`
      // would succeed here — the SAN covers that address — but naming the host
      // is what makes `verified` a statement about the certificate.
      const port = await serveHttps(minted().untrustedCa);
      const invocation = await invoke(
        ["http", `https://localhost:${String(port)}/`, "--json"],
        minted().caPath,
      );
      const tls = tlsOf(invocation, "uvp http https://localhost (CA trusted)");
      expect(tls["verification"]).toBe("verified");
      expect(tls["reason"]).toBeUndefined();
      expect(tls["subject"]).toBe("localhost");
      expect(tls["issuer"]).toBe("uvp-test-ca");
      expect(tls["protocol"]).toMatch(/^TLSv1\.[23]$/u);
    });

    it("names a certificate issued for another host as the reason, once the CA is trusted", async () => {
      // The shape that cannot be reached in-process, and the reason this file
      // spawns anything at all: OpenSSL checks the chain first, so an untrusted
      // issuer fails as an untrusted issuer no matter what the certificate is
      // called. With the CA in hand the chain is fine, and the *name* is what
      // fails — the only arrangement in which this code is observable.
      const port = await serveHttps(minted().wrongHost);
      const invocation = await invoke(
        ["http", `https://127.0.0.1:${String(port)}/`, "--json"],
        minted().caPath,
      );

      expect(invocation.exit).toBe(EXIT_WRONG);
      expect(invocation.stdout.trim()).toBe("");
      const error = parseUvpError(JSON.parse(invocation.stderr));
      expect(error.code).toBe("target_unavailable");
      expect(error.details?.["reason_code"]).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
      // The name it was issued for is in the message, so a person reads which
      // name was expected without opening the certificate.
      expect(error.message).toContain("ERR_TLS_CERT_ALTNAME_INVALID");
    });

    it("completes the exchange anyway when the caller said not to check", async () => {
      // `--no-tls` against a self-signed service. Declared, documented in the
      // usage line, and never read: `asBoolean(parsed, "tls")` reached no input
      // field, so the flag was accepted and dropped, and this call failed the
      // same way it would have with no flag at all. Built from the CLI's own
      // parser rather than by calling the service, because "the flag reaches the
      // request" is the claim.
      const port = await serveHttps(minted().selfSigned);
      const url = `https://127.0.0.1:${String(port)}/`;
      const invocation = await invoke(["http", url, "--no-tls", "--json"]);

      const result = resultOf(invocation, "uvp http --no-tls");
      expect(result["tool"]).toBe("uvp_http_request");
      expect(result["status"]).toBe(200);

      // `not_checked`, not `verified`: the caller turned enforcement off, and
      // the record says so while still reporting what OpenSSL found. A field
      // that collapsed the two would report a check nobody performed.
      const tls = tlsOf(invocation, "uvp http --no-tls");
      expect(tls["verification"]).toBe("not_checked");
      expect(tls["reason"]).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
      expect(tls["subject"]).toBe("localhost");
    });

    it("refuses the same request without the flag, and names both remedies", async () => {
      // The other half of the pair, and the reason the exit code is 2: nothing
      // is wrong with the service, and nothing is wrong with the invocation —
      // uvp cannot put the question, and the caller has to change the
      // environment before it can. `retryable` is false for the same reason, and
      // the remedy has to be the two opposite ones, because uvp cannot tell
      // whether this certificate is a private CA the caller meant to trust or a
      // development certificate nobody means to.
      const port = await serveHttps(minted().selfSigned);
      const url = `https://127.0.0.1:${String(port)}/`;
      const invocation = await invoke(["http", url, "--json"]);

      expect(invocation.exit).toBe(EXIT_WRONG);
      expect(invocation.stdout.trim()).toBe("");
      const error = parseUvpError(JSON.parse(invocation.stderr));
      expect(error.code).toBe("target_unavailable");
      expect(error.category).toBe("unsupported_target");
      expect(error.retryable).toBe(false);
      expect(error.details?.["reason_code"]).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
      // Which check was being made, so the caller knows whether turning it off
      // is a decision they are making or one uvp made for them.
      expect(error.details?.["verify_tls"]).toBe(true);
      expect(error.remediation.action).toContain("--no-tls");
      // Not the unreachable-endpoint remedy. The service answered the handshake
      // and presented a certificate; sending the caller to inspect the host and
      // port is sending them to the one part that worked.
      expect(error.remediation.action).not.toContain("listening on that host");
    });

    it("reports what it can about a certificate it will not accept, on the human path too", async () => {
      // Without `--json`, which is what a person types. The rendering is a
      // different code path from the result object, and the reason is the part
      // worth reading: `verification` says the check was not performed, and the
      // line under it says what OpenSSL found anyway.
      const port = await serveHttps(minted().expired);
      const invocation = await invoke(["http", `https://127.0.0.1:${String(port)}/`, "--no-tls"]);

      expect(invocation.stderr.trim()).toBe("");
      expect(invocation.exit).toBe(EXIT_OK);
      expect(invocation.stdout).toContain("certificate: not_checked");
      expect(invocation.stdout).toContain("CERT_HAS_EXPIRED");
    });
  },
);
