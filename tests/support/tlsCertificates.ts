import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Certificates for tests that need a real TLS peer.
 *
 * A TLS test cannot be written without one. Node has no certificate generator,
 * and a certificate committed to the repository is either a private key in a
 * public tree or a fixture that expires. So they are minted, once per test run,
 * by `openssl` — and every test that needs one skips with a named reason when
 * `openssl` is absent rather than passing without it.
 *
 * ## Five shapes, because they fail differently
 *
 * Each is a distinct thing a caller has to act on, and each code below was
 * produced by a real peer before it was written down:
 *
 * - `selfSigned` — `DEPTH_ZERO_SELF_SIGNED_CERT`. What a service generated for
 *   local use presents, and by far the most common one a caller meets.
 * - `untrustedCa` — `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. A real certificate from a
 *   private CA this client has not been told about; the fix is to hand over the
 *   CA, not to stop checking.
 * - `expired` — `CERT_HAS_EXPIRED`. Time, not configuration.
 * - `wrongHost` — `ERR_TLS_CERT_ALTNAME_INVALID`. A valid, unexpired, correctly
 *   signed certificate that names a different host.
 * - `untrustedCa` reached by the name it is valid for, with `ca` in the trust
 *   store — the positive control. Without it, a client that rejected everything
 *   would satisfy every negative case.
 *
 * The last three share one issuing CA and one leaf key, so a failure can only be
 * about the property the shape is named for.
 */

const run = promisify(execFile);

export interface TlsCertificate {
  readonly cert: string;
  readonly key: string;
  /** The name the certificate is issued for, for asserting what was read back. */
  readonly commonName: string;
}

export interface TlsCertificateStore {
  readonly directory: string;
  readonly selfSigned: TlsCertificate;
  readonly untrustedCa: TlsCertificate;
  readonly expired: TlsCertificate;
  readonly wrongHost: TlsCertificate;
  /** The CA that signed the middle three. Handing it over is what makes them verify. */
  readonly ca: string;
  /**
   * Where that CA is on disk, for a child process that can only be told by path.
   *
   * `NODE_EXTRA_CA_CERTS` takes a filename and is read once at startup, so the
   * only way to observe a verified exchange is to give a *new* process the path.
   */
  readonly caPath: string;
}

/**
 * Whether a certificate can be minted here at all.
 *
 * Asked by running it rather than by looking for it on a list of paths: an
 * `openssl` reached through `PATH` from a package manager or a container is the
 * normal case, and a check that only knew `/usr/bin` would skip a lane that
 * could have run.
 */
export const opensslAvailable: boolean =
  spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;

/**
 * Why a certificate-dependent test did not run. Empty when it did.
 *
 * Phrased as the absence it is. A lane that could not mint a certificate has
 * established nothing about how uvp reports a TLS peer, and saying so in the
 * output is the difference between a skip and a claim.
 */
export const opensslSkipReason: string =
  "openssl is not available on this host, so no certificate could be minted and nothing " +
  "about how uvp reports a TLS peer could be observed";

const openssl = async (args: readonly string[]): Promise<void> => {
  await run("openssl", [...args], { maxBuffer: 4 * 1024 * 1024 });
};

let minted: Promise<TlsCertificateStore | undefined> | undefined;

/**
 * Mint the set once, and only for a test that asks for it.
 *
 * Memoised rather than built in a `beforeAll` so a file that never reaches a TLS
 * test never pays for `openssl`, and so that two files asking at once share one
 * set instead of racing to write the same paths.
 */
export const certificates = (): Promise<TlsCertificateStore | undefined> => {
  if (!opensslAvailable) return Promise.resolve(undefined);
  minted ??= mint();
  return minted;
};

const mint = async (): Promise<TlsCertificateStore> => {
  const directory = await mkdtemp(join(tmpdir(), "uvp-tls-certs-"));
  const at = (name: string): string => join(directory, name);

  // The trust anchor, and the key every leaf uses. A shared key removes the
  // other half of a pair from every question these tests ask.
  await openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    at("ca-key.pem"),
    "-out",
    at("ca.pem"),
    "-days",
    "3650",
    "-subj",
    "/CN=uvp-test-ca",
  ]);
  await openssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    at("key.pem"),
    "-out",
    at("leaf.csr"),
    "-subj",
    "/CN=localhost",
    // On the request rather than on the signing call, because one of the shapes
    // below is signed by a CA that copies extensions from the request — and an
    // expired certificate that is *also* for the wrong host would not tell the
    // caller, or this test, which of the two the peer objected to.
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  await openssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    at("wrong.key"),
    "-out",
    at("wrong.csr"),
    "-subj",
    "/CN=other.test",
    "-addext",
    "subjectAltName=DNS:other.test",
  ]);

  // Two leaves of the CA that signed them: one for a name this client is not
  // talking to, one that verifies but for a CA the client was never told about.
  await openssl([
    "x509",
    "-req",
    "-in",
    at("wrong.csr"),
    "-CA",
    at("ca.pem"),
    "-CAkey",
    at("ca-key.pem"),
    "-CAcreateserial",
    "-out",
    at("wronghost.pem"),
    "-days",
    "2",
    "-copy_extensions",
    "copy",
  ]);
  await openssl([
    "x509",
    "-req",
    "-in",
    at("leaf.csr"),
    "-CA",
    at("ca.pem"),
    "-CAkey",
    at("ca-key.pem"),
    "-CAcreateserial",
    "-out",
    at("untrusted.pem"),
    "-days",
    "2",
    "-copy_extensions",
    "copy",
  ]);

  // Expiry is out of reach for `openssl x509`, which takes a validity *length*
  // and has no length that reaches into the past. `openssl ca` takes the dates
  // themselves, so this one shape is signed through a throwaway CA database.
  await mkdir(at("ca-db"));
  await writeFile(at("ca-db/index.txt"), "");
  await writeFile(at("ca-db/serial"), "1000\n");
  await writeFile(at("ca.cnf"), expiryCaConfig(directory));
  await openssl([
    "ca",
    "-batch",
    "-config",
    at("ca.cnf"),
    "-in",
    at("leaf.csr"),
    "-out",
    at("expired.pem"),
    "-startdate",
    "20200101000000Z",
    "-enddate",
    "20200102000000Z",
    "-notext",
  ]);

  // Self-signed, which is what a generated local service presents and what
  // `DEPTH_ZERO_SELF_SIGNED_CERT` is about.
  await openssl([
    "req",
    "-x509",
    "-new",
    "-key",
    at("key.pem"),
    "-out",
    at("selfsigned.pem"),
    "-days",
    "2",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);

  const leafKey = await readFile(at("key.pem"), "utf8");
  const read = async (name: string, key: string, commonName: string): Promise<TlsCertificate> => ({
    cert: await readFile(at(name), "utf8"),
    key,
    commonName,
  });

  return {
    directory,
    ca: await readFile(at("ca.pem"), "utf8"),
    caPath: at("ca.pem"),
    selfSigned: await read("selfsigned.pem", leafKey, "localhost"),
    untrustedCa: await read("untrusted.pem", leafKey, "localhost"),
    expired: await read("expired.pem", leafKey, "localhost"),
    wrongHost: await read("wronghost.pem", await readFile(at("wrong.key"), "utf8"), "other.test"),
  };
};

/**
 * A CA configuration built only to sign one expired certificate.
 *
 * Every path is absolute because `openssl ca` reads them relative to its own
 * working directory, not to the configuration file. `unique_subject = no` so
 * that signing the same request twice in one directory cannot fail on an index
 * that already holds it.
 */
const expiryCaConfig = (directory: string): string => `[ca]
default_ca = CA_default
[CA_default]
database = ${directory}/ca-db/index.txt
serial = ${directory}/ca-db/serial
new_certs_dir = ${directory}/ca-db
certificate = ${directory}/ca.pem
private_key = ${directory}/ca-key.pem
default_md = sha256
policy = policy_any
email_in_dn = no
rand_serial = no
unique_subject = no
copy_extensions = copy
[policy_any]
commonName = supplied
`;
