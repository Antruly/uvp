import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DoctorService, headerProbeAt } from "./DoctorService.js";
import { createRecorder } from "./evidenceHelpers.js";
import type { LibuvcppBuild } from "./ToolchainProvider.js";
import { createFakeToolchain } from "../../tests/conformance/fakeToolchain.js";

/**
 * `application` does not import a provider, not even from a test — so the host
 * question is asked of the platform here rather than through `toolchains/host`.
 */
const isWindows = process.platform === "win32";

/**
 * What the header probe answers when it cannot answer.
 *
 * The probe decides `grpc` — the one feature with no configuration symbol — so
 * "the header is absent" and "the probe could not look" are different verdicts:
 * the first becomes `unmet` with a rebuild instruction, the second
 * `undetermined`. Only "nothing is there" (`ENOENT`, `ENOTDIR`) may become
 * absence; every other failure has to stay undecided (AGENTS.md: "An unavailable
 * probe yields `undetermined`, not `unmet`").
 *
 * A real libuvcpp install cannot be made to produce a symlink loop or an I/O
 * error, so the cases are written against the probe directly.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

/**
 * `title`, on the host where the errno cannot be produced.
 *
 * A self-referencing symlink is not a portable way to make `stat` fail: on
 * Windows every candidate below it answered `ENOENT`/`ENOTDIR` in CI, so the
 * loop is reported as "not there" by the platform itself. The classification is
 * about errnos the host can hand back; where it cannot hand this one back, this
 * file has no coverage to claim and says why.
 */
const named = (title: string): string =>
  isWindows
    ? `${title} — skipped: this host reports a self-referencing symlink as ENOENT/ENOTDIR, not ELOOP`
    : title;

/** An install prefix to point the probe at. */
const prefixRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "uvp-probe-"));
  directories.push(root);
  return root;
};

describe("the header probe", () => {
  it("finds a header in the layout libuvcpp installs", async () => {
    const root = await prefixRoot();
    await mkdir(join(root, "include", "uvcpp"), { recursive: true });
    await writeFile(join(root, "include", "uvcpp", "uvcpp_ssl_context.h"), "");

    await expect(headerProbeAt(root)("uvcpp_ssl_context.h")).resolves.toBe(true);
  });

  it("says absent when the prefix holds no candidate at all", async () => {
    const root = await prefixRoot();

    await expect(headerProbeAt(root)("grpc")).resolves.toBe(false);
  });

  it("treats a file where a directory must be as absent, not undecided", async () => {
    const root = await prefixRoot();
    // Every candidate then fails with ENOTDIR (or ENOENT for the last), which
    // is the path not being there rather than the probe being unable to look.
    await writeFile(join(root, "include"), "not a directory");

    await expect(headerProbeAt(root)("grpc")).resolves.toBe(false);
  });

  it.skipIf(isWindows)(named("does not call a path it could not look through absent"), async () => {
    const root = await prefixRoot();
    await mkdir(join(root, "include"), { recursive: true });
    // `include/uvcpp` points at itself, so every candidate below it fails with
    // ELOOP. The directory is there; the probe cannot see through it.
    await symlink("uvcpp", join(root, "include", "uvcpp"));

    await expect(headerProbeAt(root)("grpc")).resolves.toBeUndefined();
  });

  it.skipIf(isWindows)(named("keeps walking past a layout it could not look through"), async () => {
    const root = await prefixRoot();
    await mkdir(join(root, "include"), { recursive: true });
    // The libuvcpp layout is unsearchable, the fallback layout holds the
    // header. One failed lookup is not a reason to stop: the fallback's
    // header is a positive observation, and answering "undecided" here would
    // discard something the probe did see.
    await symlink("uvcpp", join(root, "include", "uvcpp"));
    await writeFile(join(root, "include", "grpc"), "");

    await expect(headerProbeAt(root)("grpc")).resolves.toBe(true);
  });

  it("answers for a missing prefix without looking at the filesystem", async () => {
    await expect(headerProbeAt(undefined)("grpc")).resolves.toBeUndefined();
  });
});

/**
 * The pkg-config requirement the doctor adds, and when it must not.
 *
 * A libuvcpp release archive ships only `lib/pkgconfig/uvcpp.pc`, so the
 * generated project's `find_package(uvcpp CONFIG)` fails and its pkg-config
 * fallback runs. On a Windows host whose only `pkg-config` is a `.bat` wrapper
 * that fallback finds no executable, and configure dies in CMake's
 * `FindPkgConfig`. The doctor used to report such a host ready, because
 * pkg-config was never part of its inspection.
 *
 * The requirement is conditional on three observations — the library was found,
 * it was seen to have no CMake package config, and the provider looked for
 * pkg-config and did not find one — and each case below removes one of them.
 * The last case is the third state: a provider that did not look gets no
 * requirement, because "I could not look" is not "it is missing".
 */
describe("the pkg-config requirement on a libuvcpp route", () => {
  /** A report from one fake provider with the given observations. */
  const reportWith = async (options: {
    readonly cmakePackage?: boolean;
    readonly pkgConfig?: { readonly path?: string };
    readonly found?: boolean;
  }) => {
    const libuvcpp: LibuvcppBuild = {
      found: options.found ?? true,
      version: "1.7.0",
      versionSource: "pkgconfig",
      installPrefix: "/opt/uvcpp",
      modules: [],
      ...(options.cmakePackage === undefined ? {} : { cmakePackage: options.cmakePackage }),
    };
    const provider = createFakeToolchain({
      libuvcpp,
      ...(options.pkgConfig === undefined ? {} : { pkgConfig: options.pkgConfig }),
    });
    const service = new DoctorService({
      providers: [provider],
      toolchainFor: () => provider,
      // Nothing here is a header-probed feature; a probe that answers `false`
      // keeps the feature section from touching this machine's filesystem.
      headerProbe: async () => false,
    });
    const recorder = createRecorder();
    const report = await service.doctor({}, recorder, new AbortController().signal);
    return { report, recorder };
  };

  it("is reported when the install has no CMake package and pkg-config is absent", async () => {
    const { report, recorder } = await reportWith({ cmakePackage: false, pkgConfig: {} });

    const [toolchain] = report.toolchains;
    expect(toolchain?.missing.map((gap) => gap.id)).toContain("pkg-config");
    // The evidence record and the report agree: the requirement is recorded
    // once, in the same record that reports the toolchain.
    const evidence = recorder.evidence.find((entry) => entry.kind === "toolchain");
    expect(evidence?.observed["missing"]).toContain("pkg-config");
    // cmake alone cannot configure this workspace, which is the difference
    // between "the host has a build system" and "the build can be configured".
    expect(evidence?.derived?.["can_configure"]).toBe(false);
    expect(recorder.unknowns.map((unknown) => unknown.question)).toContain(
      "Is pkg-config available on fake?",
    );
  });

  it("is not reported when the fallback has an executable to run", async () => {
    const { report } = await reportWith({
      cmakePackage: false,
      pkgConfig: { path: "/usr/bin/pkg-config" },
    });

    expect(report.toolchains[0]?.missing.map((gap) => gap.id)).not.toContain("pkg-config");
  });

  it("is not reported when find_package(uvcpp CONFIG) can answer", async () => {
    // The CMake package route never reaches the fallback, so an executable
    // pkg-config is not a prerequisite of this host — even though there is
    // none. Requiring it here would send someone to install a program this
    // workspace will never invoke.
    const { report } = await reportWith({ cmakePackage: true, pkgConfig: {} });

    expect(report.toolchains[0]?.missing.map((gap) => gap.id)).not.toContain("pkg-config");
  });

  it("is not reported when the provider did not look for pkg-config", async () => {
    // The third state. A provider that never examined the executable (the
    // container provider does not) has established nothing, and turning that
    // into "install pkg-config" would be a finding nobody made.
    const { report, recorder } = await reportWith({ cmakePackage: false });

    expect(report.toolchains[0]?.missing.map((gap) => gap.id)).not.toContain("pkg-config");
    expect(recorder.unknowns.map((unknown) => unknown.question)).not.toContain(
      "Is pkg-config available on fake?",
    );
  });

  it("is not reported when there is no libuvcpp route to judge", async () => {
    const { report } = await reportWith({ found: false, cmakePackage: false, pkgConfig: {} });

    expect(report.toolchains[0]?.missing.map((gap) => gap.id)).not.toContain("pkg-config");
  });
});
