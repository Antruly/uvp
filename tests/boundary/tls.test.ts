import { createServer } from "node:https";
import { createSecureServer } from "node:http2";
import type { Server } from "node:https";
import type { Http2SecureServer, ServerHttp2Stream } from "node:http2";

import { afterAll, describe, expect, it } from "vitest";

import {
  performRequest,
  TransportFailure,
  transportFailureKind,
} from "../../src/application/httpClient.js";
import type { HttpRequestSpec, TlsInfo } from "../../src/application/httpClient.js";
import { certificates, opensslAvailable, opensslSkipReason } from "../support/tlsCertificates.js";
import type { TlsCertificate, TlsCertificateStore } from "../support/tlsCertificates.js";

/**
 * What uvp's client reports about the certificate on a real TLS connection.
 *
 * Against real peers, because there is no way to observe this without one: the
 * chain outcome is OpenSSL's answer, the reason is OpenSSL's spelling of it, and
 * both arrive on a socket. Every certificate below is minted at run time — a
 * committed one would be a private key in a public tree, and would expire.
 *
 * ## The regression this file exists for
 *
 * `TlsInfo` was built from `res.socket` read inside the response's `end`
 * handler, and Node has detached the socket by then: it is `null`. The read is
 * `socket.getPeerCertificate`, so it threw a `TypeError` — inside the client,
 * out of the promise, into whatever catch the caller had. Every HTTPS request
 * that got as far as a response died there, and `uvp http` reported a working
 * service as an unreachable endpoint. The certificate fields beside it were
 * literals — `verified: false`, `errors: []` — so they were never the thing
 * under test, and no test noticed that the code path could not run.
 *
 * The first test in "an exchange that completed" is that path, and it fails
 * against the code as it was.
 *
 * ## Why both protocols are here
 *
 * The two stacks read the socket differently and fail differently. HTTP/2
 * reports a rejected certificate as `ERR_HTTP2_STREAM_CANCEL` on the stream with
 * the session's `DEPTH_ZERO_SELF_SIGNED_CERT` as its `cause`, so a client that
 * classified what it caught first called a certificate failure a protocol
 * mismatch — and told the caller to change the protocol. A fix that only ran the
 * HTTP/1.1 path would not have shown it.
 */

const certs: TlsCertificateStore | undefined = await certificates();

/** The minted set. Every test below is skipped when there is none. */
const minted = (): TlsCertificateStore => {
  if (certs === undefined) throw new Error(opensslSkipReason);
  return certs;
};

const SPEC: Omit<HttpRequestSpec, "url" | "httpVersion" | "verifyTls"> = {
  method: "GET",
  headers: {},
  body: undefined,
  followRedirects: false,
  maxRedirects: 0,
  timeoutMs: 5_000,
};

const servers: (Server | Http2SecureServer)[] = [];

afterAll(() => {
  for (const server of servers) server.close();
});

/** An HTTPS peer on a loopback port, answering `ok`. */
const serveHttps = async (certificate: TlsCertificate): Promise<string> => {
  const server = createServer({ cert: certificate.cert, key: certificate.key }, (_, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
  return `https://127.0.0.1:${String(port)}/`;
};

/**
 * A peer that speaks HTTP/2 over TLS, and only that.
 *
 * `allowHTTP1` is passed explicitly: it defaults to `true`, which routes a
 * connection through the compatibility request/response pair and leaves the
 * `stream` listener below receiving a response object with no `respond`. Naming
 * it false is what makes this an h2-only peer.
 */
const serveH2 = async (certificate: TlsCertificate): Promise<string> => {
  const server = createSecureServer(
    { cert: certificate.cert, key: certificate.key, allowHTTP1: false },
    () => {
      /* Every stream is answered by the listener below. */
    },
  );
  server.on("stream", (stream: ServerHttp2Stream) => {
    stream.respond({ ":status": 200, "content-type": "text/plain" });
    stream.end("ok");
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
  return `https://127.0.0.1:${String(port)}/`;
};

/** What a request failed with: the kind, the reason code, and the message. */
const failureOf = async (
  spec: HttpRequestSpec,
): Promise<{
  readonly kind: string;
  readonly code: string | undefined;
  readonly message: string;
}> => {
  const outcome = await performRequest(spec).then(
    (exchange) => ({ resolved: true as const, exchange }),
    (cause: unknown) => ({ resolved: false as const, cause }),
  );
  if (outcome.resolved) throw new Error("the request was expected to fail and did not");
  return {
    kind: transportFailureKind(outcome.cause),
    code: outcome.cause instanceof TransportFailure ? outcome.cause.code : undefined,
    message: outcome.cause instanceof Error ? outcome.cause.message : String(outcome.cause),
  };
};

/** The TLS record of a request that is expected to succeed. */
const tlsOf = async (spec: HttpRequestSpec): Promise<TlsInfo> => {
  const exchange = await performRequest(spec);
  if (exchange.tls === undefined) throw new Error("the exchange reported no TLS at all");
  return exchange.tls;
};

const describeWithCertificates = describe.skipIf(!opensslAvailable);

describeWithCertificates(
  opensslAvailable
    ? "the certificate on a real TLS connection"
    : `the certificate on a real TLS connection — skipped: ${opensslSkipReason}`,
  () => {
    /**
     * The shapes uvp has to tell apart, and the code each really raised.
     *
     * The code is asserted rather than the message because the message does not
     * contain it: Node reports expiry as "certificate has expired" and a
     * self-signed leaf as "self-signed certificate; if the root CA is installed
     * locally, try running Node.js with --use-system-ca". Four different things
     * for a caller to do, and no stable name for any of them in the text.
     *
     * The fourth shape — a valid certificate that names a different host — is
     * not reachable from here, and the reason is worth knowing: OpenSSL builds
     * and validates the chain *before* it looks at the name, so a certificate
     * from an untrusted CA fails as an untrusted CA whatever it is called. Only
     * from a trusted issuer can the identity be the thing that fails, and
     * trusting an issuer in this process is the one thing a test cannot arrange.
     * That shape is observed in `tests/boundary/cli/tls.test.ts`, where uvp is
     * spawned with the CA in its environment.
     */
    const rejections: readonly {
      readonly shape: string;
      readonly certificate: () => TlsCertificate;
      readonly code: string;
    }[] = [
      {
        shape: "a self-signed certificate",
        certificate: () => minted().selfSigned,
        // Measured. The shape a service generated for local use presents.
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      },
      {
        shape: "a certificate from a CA this client was never told about",
        certificate: () => minted().untrustedCa,
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      },
      {
        shape: "an expired certificate",
        certificate: () => minted().expired,
        code: "CERT_HAS_EXPIRED",
      },
    ];

    for (const { shape, certificate, code } of rejections) {
      it(`rejects ${shape}, and says which one it was`, async () => {
        const url = await serveHttps(certificate());
        const failure = await failureOf({ ...SPEC, url, httpVersion: "1.1", verifyTls: true });

        // Not `endpoint_unreachable`. The service is listening, the handshake
        // completed, and it presented a certificate — and a caller told to check
        // the host and port goes to inspect the one part that worked. The kind
        // is what decides both the code the caller reads and whether they are
        // invited to retry.
        expect(failure.kind, failure.message).toBe("tls");
        expect(failure.code, failure.message).toBe(code);
      });
    }

    it("reports an exchange over an unverified connection instead of failing it", async () => {
      // The regression, stated as the thing that must now work: an HTTPS request
      // that completes produces an exchange carrying the certificate it was
      // given. Against the code as it was, this threw a `TypeError` out of the
      // client — `res.socket` is null by the time the response has been read —
      // and the caller's catch turned a working service into an unreachable
      // endpoint.
      //
      // It is also the positive control for the three rejections above: a client
      // that refused every connection carrying a certificate it could not verify
      // would satisfy all of them and be useless.
      const url = await serveHttps(minted().selfSigned);
      const exchange = await performRequest({ ...SPEC, url, httpVersion: "1.1", verifyTls: false });
      expect(exchange.status).toBe(200);
      expect(exchange.body.toString("utf8")).toBe("ok");

      // `not_checked`, and not `failed`. The caller turned enforcement off; the
      // chain did not validate, and the record says both — which is the whole
      // reason it is not the boolean it was, where the literal `false` answered
      // "rejected" for a check nobody had been asked to perform.
      const tls = await tlsOf({ ...SPEC, url, httpVersion: "1.1", verifyTls: false });
      expect(tls.verification).toBe("not_checked");
      expect(tls.reason).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
      // Read off the socket rather than defaulted, which is what makes the
      // record evidence: these came from the peer's certificate.
      expect(tls.subject).toBe("localhost");
      expect(tls.issuer).toBe("localhost");
      expect(tls.protocol).toMatch(/^TLSv1\.[23]$/u);
      expect(tls.cipher).toBeTruthy();
      expect(tls.validFrom).toBeTruthy();
      expect(tls.validTo).toBeTruthy();
    });

    it("still says what was wrong with a chain it was not asked to enforce", async () => {
      // The reason verification can be turned off to look: Node runs the same
      // validation either way and records what it found. A client that skipped
      // the check when it skipped enforcement would leave the caller with a
      // connection they cannot judge — which is the state `verified: false` and
      // `errors: []` reported for every TLS exchange, including this one.
      const url = await serveHttps(minted().expired);
      const tls = await tlsOf({ ...SPEC, url, httpVersion: "1.1", verifyTls: false });
      expect(tls.verification).toBe("not_checked");
      expect(tls.reason).toBe("CERT_HAS_EXPIRED");
      // The dates come from the certificate, so they are the evidence for the
      // reason rather than a restatement of it.
      expect(tls.subject).toBe("localhost");
      expect(new Date(String(tls.validTo)).getTime()).toBeLessThan(Date.now());
    });

    it("reports the certificate on an HTTP/2 exchange too", async () => {
      // The other read site, and the other way to get it wrong: an h2 session
      // hands its socket over through `client.socket`, and it is gone once the
      // session is closed. Read after the close, the same certificate is absent
      // — and an absent one is not the same as one that was never presented.
      const url = await serveH2(minted().untrustedCa);
      const exchange = await performRequest({ ...SPEC, url, httpVersion: "2", verifyTls: false });
      expect(exchange.status).toBe(200);
      expect(exchange.httpVersion).toBe("2.0");
      expect(exchange.tls?.verification).toBe("not_checked");
      expect(exchange.tls?.subject).toBe("localhost");
      expect(exchange.tls?.reason).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    });

    it("calls a rejected certificate rejected on the HTTP/2 path, not a protocol mismatch", async () => {
      // The classification the h2 stack gets wrong on its own. A stream whose
      // session died reports `ERR_HTTP2_STREAM_CANCEL`, which is an
      // `ERR_HTTP2*` code — so the rule that reads those as "the peer is
      // speaking something else" classified a rejected certificate as a
      // version mismatch, and the remedy sent the caller to rebuild the service
      // with the http2 feature. The session's own error is the reason, and it
      // is attached as the wrapper's `cause`.
      const url = await serveH2(minted().selfSigned);
      const failure = await failureOf({ ...SPEC, url, httpVersion: "2", verifyTls: true });
      expect(failure.kind, failure.message).toBe("tls");
      expect(failure.code, failure.message).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    });

    it("calls an HTTPS peer that will not speak HTTP/2 a protocol mismatch, not a bad certificate", async () => {
      // The other side of the same boundary, and the reason the rule above is a
      // list rather than a prefix. The alert this raises begins `ERR_SSL`, so a
      // client that read that prefix as "certificate" would tell the caller to
      // look at a certificate that is fine — when the peer has simply declined
      // every protocol offered, which is what the h2 fallback exists for.
      const url = await serveHttps(minted().untrustedCa);
      const failure = await failureOf({ ...SPEC, url, httpVersion: "2", verifyTls: false });
      expect(failure.kind, failure.message).toBe("protocol");
      expect(failure.code, failure.message).toBe("ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL");
    });
  },
);
