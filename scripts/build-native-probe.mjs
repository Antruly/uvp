#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { importCompiled, REPO_ROOT } from "./lib/paths.mjs";

/**
 * Build the native WebSocket probe.
 *
 * The probe links libuvcpp's C ABI, so it needs two things that a checkout does
 * not necessarily have: a C++ toolchain and a libuvcpp install built with
 * `UVCPP_ENABLE_CAPI=ON`. When either is missing this says which one, and CI's
 * real-libuvcpp lane is where it is expected to succeed — the release archives do
 * ship the C ABI, so a machine with libuvcpp 1.7.0 unpacked can build it by hand
 * too.
 *
 * The install is located by uvp's own toolchain discovery rather than by a second
 * search order written here: `LocalToolchainProvider.findLibuvcpp` is what knows
 * the environment variables, the conventional prefixes, and the two routes a
 * libuvcpp install is published through. This script asks it for a prefix and
 * derives the include directory and the library file from it.
 *
 * Output goes to `.cache/native-probe/`, which is gitignored and is not the
 * repository: a built binary is a build artifact, and the one thing this project
 * does not do is commit those.
 */

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    jobs: { type: "string" },
    clean: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

const OUTPUT_DIR = path.resolve(values.out ?? path.join(REPO_ROOT, ".cache", "native-probe"));
const SOURCE_DIR = path.join(REPO_ROOT, "native", "uvcpp-probe");

if (values.help) {
  console.log(`Usage: node scripts/build-native-probe.mjs [--out DIR] [--jobs N] [--clean]

Configures and builds native/uvcpp-probe against the libuvcpp install that
uvp's toolchain discovery finds. LIBUVCPP_ROOT, UVCPP_ROOT, or CMAKE_PREFIX_PATH
pins a specific install.

Output: ${path.relative(REPO_ROOT, OUTPUT_DIR)}/uvcpp-probe
`);
  process.exit(0);
}

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });

const fail = (message, detail) => {
  console.error(`build-native-probe: ${message}`);
  if (detail !== undefined && detail.trim() !== "") {
    for (const line of detail.trim().split("\n").slice(-20)) console.error(`  ${line}`);
  }
  process.exit(1);
};

const libraryFileName = () => {
  if (process.platform === "win32") return ["uvcpp.lib", "uvcpp.dll"];
  if (process.platform === "darwin") return ["libuvcpp.dylib", "libuvcpp.a"];
  return ["libuvcpp.so", "libuvcpp.a"];
};

const findLibrary = (prefix) => {
  const directories = [
    path.join(prefix, "lib"),
    path.join(prefix, "lib64"),
    path.join(prefix, "bin"),
  ];
  for (const directory of directories) {
    for (const name of libraryFileName()) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
};

const { LocalToolchainProvider } = await importCompiled(
  "toolchains/local/LocalToolchainProvider.js",
);
const provider = new LocalToolchainProvider();
const controller = new AbortController();
const libuvcpp = await provider.findLibuvcpp(undefined, controller.signal);

if (!libuvcpp.found || libuvcpp.installPrefix === undefined) {
  fail(
    "no libuvcpp install was found, so the probe would have nothing to link against.",
    [
      "Set LIBUVCPP_ROOT (or UVCPP_ROOT / CMAKE_PREFIX_PATH) to a libuvcpp install.",
      "For a release archive, that is the directory holding include/ and lib/.",
      libuvcpp.note === undefined ? "" : `Discovery said: ${libuvcpp.note}`,
    ].join("\n"),
  );
}

const includeDir = path.join(libuvcpp.installPrefix, "include");
if (!existsSync(path.join(includeDir, "capi", "uvcpp_c.h"))) {
  fail(
    `libuvcpp at ${libuvcpp.installPrefix} has no capi/uvcpp_c.h, so it was built without its C ABI.`,
    "Rebuild libuvcpp with -DUVCPP_ENABLE_CAPI=ON and install it, then run this again.",
  );
}

const library = findLibrary(libuvcpp.installPrefix);
if (library === undefined) {
  fail(
    `libuvcpp at ${libuvcpp.installPrefix} has headers but no library this script can name.`,
    `Looked for ${libraryFileName().join(", ")} in lib/, lib64/, and bin/.`,
  );
}

console.log(`libuvcpp   ${libuvcpp.version ?? "version unknown"} at ${libuvcpp.installPrefix}`);
console.log(`library    ${library}`);
console.log(`output     ${OUTPUT_DIR}`);

if (values.clean) await rm(OUTPUT_DIR, { recursive: true, force: true });
await mkdir(OUTPUT_DIR, { recursive: true });

const buildDir = path.join(OUTPUT_DIR, "build");
const configure = await run("cmake", [
  "-S",
  SOURCE_DIR,
  "-B",
  buildDir,
  "-DCMAKE_BUILD_TYPE=Release",
  `-DUVCPP_INCLUDE_DIR=${includeDir}`,
  `-DUVCPP_LIBRARY=${library}`,
]);
if (configure.code !== 0) {
  fail("cmake could not configure the probe.", `${configure.stdout}\n${configure.stderr}`);
}

const build = await run("cmake", [
  "--build",
  buildDir,
  "--config",
  "Release",
  ...(values.jobs === undefined ? [] : ["--parallel", values.jobs]),
]);
if (build.code !== 0) {
  fail("the probe did not compile.", `${build.stdout}\n${build.stderr}`);
}

const executableName = process.platform === "win32" ? "uvcpp-probe.exe" : "uvcpp-probe";
const candidates = [
  path.join(buildDir, executableName),
  path.join(buildDir, "Release", executableName),
];
const built = candidates.find((candidate) => existsSync(candidate));
if (built === undefined) {
  fail(
    `cmake reported success but ${executableName} is not where it should be.`,
    candidates.join("\n"),
  );
}

console.log(`built      ${built}`);

// Self-check: the probe answers --version by reporting the ABI it was built
// against and the library version it loaded. A binary that cannot do that is a
// binary that would fail at the first probe, and finding that out here costs one
// second instead of a mystery later.
const version = await run(built, ["--version"]);
if (version.code !== 0) {
  fail("the probe was built but does not run.", `${version.stdout}\n${version.stderr}`);
}
console.log(`probe      ${version.stdout.trim()}`);
