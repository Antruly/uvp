import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { headerProbeAt } from "./DoctorService.js";

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
