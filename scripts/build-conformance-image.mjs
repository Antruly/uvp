#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { importCompiled, REPO_ROOT } from "./lib/paths.mjs";

/**
 * Build the image the container provider's build obligations run in.
 *
 * ## Why this is a script and not a test lane
 *
 * `tests/toolchain/containerConformance.test.ts` will not fetch an image, and
 * neither will this file do it on the lane's behalf. A lane that pulled its own
 * fixture would be testing a network as much as a toolchain, and would pass on a
 * machine that happens to reach a registry while failing on one that does not —
 * which is a property of the network, reported as a property of uvp. So the
 * base image must already be present, and this says which command to run when it
 * is not.
 *
 * The image *is* built here rather than committed anywhere, because the thing
 * the obligations need is not a base — it is a C++ toolchain **with a libuvcpp
 * inside it**, and there is no published image that carries this machine's
 * install. Building it from the install that uvp's own discovery found is what
 * makes the lane's toolchain the same one every other lane compiles against.
 *
 * ## Where the libuvcpp comes from
 *
 * `LocalToolchainProvider.findLibuvcpp`, not a search order written here. That
 * module knows the environment variables, the conventional prefixes, and the two
 * routes a libuvcpp install is published through; a second answer to "where is
 * libuvcpp" is a second thing that can disagree with every other lane that asks.
 *
 * ## Why the apt host is an argument too
 *
 * `--apt-host` rewrites the host in whatever apt sources the base image ships,
 * leaving the suite and the path alone. It exists because the layer it governs is
 * the slow one: the same archive measured 21.9 KB/s from its own host and
 * 7.5 MB/s from a mirror of it, which is the difference between a build that
 * finishes and one that does not. Like `--base`, it is how a host describes its
 * own route without that route being committed.
 *
 * ## The build context
 *
 * A fresh temporary directory, into which exactly two things are copied: the
 * Containerfile, and the install prefix's `include/` and `lib/`. Nothing runs
 * from that directory — it is read by `podman build` and deleted afterwards —
 * and nothing is copied out of the libuvcpp tree except the two directories an
 * install prefix consists of.
 */

const DEFAULT_IMAGE = "uvp-conformance-image:local";
const DEFAULT_BASE = "docker.io/library/debian:12-slim";
const DEFAULT_APT_HOST = "deb.debian.org";

const { values } = parseArgs({
  options: {
    image: { type: "string" },
    base: { type: "string" },
    "apt-host": { type: "string" },
    runtime: { type: "string" },
    "keep-context": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

const IMAGE = values.image ?? DEFAULT_IMAGE;
const BASE = values.base ?? process.env["UVP_CONFORMANCE_BASE"] ?? DEFAULT_BASE;
const APT_HOST = values["apt-host"] ?? process.env["UVP_CONFORMANCE_APT_HOST"] ?? DEFAULT_APT_HOST;
const CONTAINERFILE = path.join(REPO_ROOT, "scripts", "container", "Containerfile");

if (values.help) {
  console.log(`Usage: node scripts/build-conformance-image.mjs [options]

Builds the image the container provider's build obligations run in: Debian with a
C++ toolchain, CMake, pkg-config, and the libuvcpp install that uvp's own
toolchain discovery finds, at /opt/libuvcpp.

Options:
  --image NAME      Tag for the built image. Default ${DEFAULT_IMAGE}
  --base REF        Base image, which must already be present. Default ${DEFAULT_BASE}
                    UVP_CONFORMANCE_BASE sets the same thing, which is how a host
                    whose registry access goes through a mirror says so without
                    editing this file.
  --apt-host HOST   Host the image's apt sources are rewritten to. Default ${DEFAULT_APT_HOST}
                    UVP_CONFORMANCE_APT_HOST sets the same thing. Only the host changes;
                    the suite and path stay whatever the base image declares. Worth naming
                    when the distribution's own host is slow from here — the difference
                    measured on one machine was 21.9 KB/s against 7.5 MB/s.
  --runtime NAME    Container runtime to use. Default: the first of podman, docker.
  --keep-context    Leave the build context in place and print its path.

Then point the lane at it:

  UVP_TEST_IMAGE=${IMAGE} npm run test:focused -- tests/toolchain/containerConformance.test.ts
`);
  process.exit(0);
}

const fail = (message, detail) => {
  console.error(`build-conformance-image: ${message}`);
  if (detail !== undefined && detail.trim() !== "") {
    for (const line of detail.trim().split("\n").slice(-20)) console.error(`  ${line}`);
  }
  process.exit(1);
};

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

/** The runtime to build with, named rather than guessed at from a failure later. */
const findRuntime = async () => {
  if (values.runtime !== undefined) return values.runtime;
  for (const candidate of ["podman", "docker"]) {
    const found = await run(candidate, ["--version"]);
    if (found.code === 0) return candidate;
  }
  fail(
    "no container runtime was found, so there is nothing to build the image with.",
    "Install podman or docker, or pass --runtime with the binary to use.",
  );
};

const runtime = await findRuntime();

// The base must be present. This is the same rule the provider holds itself to,
// and it is enforced before any build argument is assembled rather than after a
// failed pull, because a pull that *would* have worked here is still the wrong
// thing for this script to do on a lane's behalf.
const basePresent = await run(runtime, ["image", "exists", BASE]);
if (basePresent.code !== 0) {
  fail(`${BASE} is not present locally, and this script does not fetch images.`, [
    `Fetch it with:  ${runtime} pull ${BASE}`,
    "On a host whose registry access goes through a mirror, pull the mirror's",
    "reference and pass it as --base (or UVP_CONFORMANCE_BASE).",
  ]);
}

const { LocalToolchainProvider } = await importCompiled(
  "toolchains/local/LocalToolchainProvider.js",
);
const provider = new LocalToolchainProvider();
const libuvcpp = await provider.findLibuvcpp(undefined, new AbortController().signal);

if (!libuvcpp.found || libuvcpp.installPrefix === undefined) {
  fail(
    "no libuvcpp install was found, so the image would have no library in it.",
    [
      "Set LIBUVCPP_ROOT (or UVCPP_ROOT / CMAKE_PREFIX_PATH) to a libuvcpp install.",
      "For a release archive, that is the directory holding include/ and lib/.",
      libuvcpp.note === undefined ? "" : `Discovery said: ${libuvcpp.note}`,
    ].join("\n"),
  );
}

const prefix = libuvcpp.installPrefix;
for (const required of ["include", "lib"]) {
  if (!existsSync(path.join(prefix, required))) {
    fail(
      `libuvcpp at ${prefix} has no ${required}/, so it is not an install prefix.`,
      "A release archive unpacks to a directory holding include/ and lib/.",
    );
  }
}

const context = await mkdtemp(path.join(tmpdir(), "uvp-conformance-image-"));
await cp(CONTAINERFILE, path.join(context, "Containerfile"));
for (const directory of ["include", "lib"]) {
  await cp(path.join(prefix, directory), path.join(context, "libuvcpp", directory), {
    recursive: true,
  });
}

console.log(`Building ${IMAGE}`);
console.log(`  base        ${BASE} (already present)`);
console.log(`  apt host    ${APT_HOST}`);
console.log(`  libuvcpp    ${prefix}`);
console.log(`  context     ${context}`);

const built = await run(runtime, [
  "build",
  "--file",
  path.join(context, "Containerfile"),
  "--build-arg",
  `BASE_IMAGE=${BASE}`,
  "--build-arg",
  `APT_HOST=${APT_HOST}`,
  "--tag",
  IMAGE,
  context,
]);

if (built.code !== 0) {
  if (!values["keep-context"]) await rm(context, { recursive: true, force: true });
  fail(`the image did not build (exit ${String(built.code)}).`, `${built.stdout}\n${built.stderr}`);
}

if (values["keep-context"]) console.log(`  kept        ${context}`);
else await rm(context, { recursive: true, force: true });

// Read back what was built, rather than reporting the tag as if it were proof.
// `image exists` answers about the tag; the size and id come from `image inspect`
// so that the line below is a fact about this build and not about the request.
const inspected = await run(runtime, ["image", "inspect", IMAGE, "--format", "{{.Id}} {{.Size}}"]);
console.log(`\n${IMAGE} is present: ${inspected.stdout.trim()}`);
console.log(`\nRun the container lane against it:`);
console.log(
  `  UVP_TEST_IMAGE=${IMAGE} npm run test:focused -- tests/toolchain/containerConformance.test.ts`,
);
