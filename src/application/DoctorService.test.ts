import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { headerProbeAt } from "./DoctorService.js";

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

  it("does not call a path it could not look through absent", async () => {
    const root = await prefixRoot();
    await mkdir(join(root, "include"), { recursive: true });
    // `include/uvcpp` points at itself, so every candidate below it fails with
    // ELOOP. The directory is there; the probe cannot see through it.
    await symlink("uvcpp", join(root, "include", "uvcpp"));

    await expect(headerProbeAt(root)("grpc")).resolves.toBeUndefined();
  });

  it("answers for a missing prefix without looking at the filesystem", async () => {
    await expect(headerProbeAt(undefined)("grpc")).resolves.toBeUndefined();
  });
});
