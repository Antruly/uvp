import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { sha256 } from "../domain/identity.js";
import type { TemplatePackageFile } from "../domain/templatePackage.js";
import {
  TemplateStoreError,
  getTemplatePackage,
  type TemplateStoreOptions,
} from "./TemplateStore.js";

/**
 * Export one stored package to a directory (P4 of #236).
 *
 * The store is the owner of what a package means: this module asks
 * `getTemplatePackage` for the validated package and copies the tree it names.
 * After the copy it re-reads every file and compares the digest and byte count
 * with the manifest's `files[]` entry, so an export that reports success is an
 * export whose bytes match the manifest — a tampered store entry fails here
 * rather than being handed to a caller as a package.
 *
 * ## Where the bytes go
 *
 * The target must be absent or an empty directory; a non-empty target is
 * refused rather than merged into, because "export over my directory" is not
 * something a caller can undo. The copy is staged in a sibling directory on the
 * same filesystem and renamed into place only after verification, so a failed
 * export leaves no partial package at the target. A cleanup that fails is
 * reported in the error's details, not hidden. Parent directories created for
 * an absent target are left in place when the copy fails: the no-partial-package
 * invariant covers the package, not the empty ancestors.
 */

export interface ExportTemplatePackageOptions extends TemplateStoreOptions {
  /** Must be absent or empty; it is created (with parents) when absent. */
  readonly targetDir: string;
}

export interface ExportTemplatePackageResult {
  readonly path: string;
  readonly id: string;
  readonly version: string;
  /** The package digest the store reported; the same value `get` returns. */
  readonly digest: string;
  readonly files: readonly TemplatePackageFile[];
  /** The sum of `files[].bytes`, not the on-disk allocation. */
  readonly bytes: number;
}

const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

const isAbsent = (error: unknown): boolean => codeOf(error) === "ENOENT";

/** True when `child` names a path below `parent`, not `parent` itself. */
const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  // `..` must be a whole segment: a sibling named `..out` has the relative
  // path `..out`, which is a child of `parent` despite the prefix.
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const assertTargetIsFree = async (target: string): Promise<boolean> => {
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if (isAbsent(error)) return false;
    throw new TemplateStoreError(
      "io_error",
      `could not stat ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!info.isDirectory()) {
    throw new TemplateStoreError("target_exists", `${target} exists and is not a directory`);
  }
  const entries = await readdir(target).catch((error: unknown) => {
    throw new TemplateStoreError(
      "io_error",
      `could not list ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (entries.length > 0) {
    throw new TemplateStoreError("target_exists", `${target} is not empty`);
  }
  return true;
};

const copyTree = async (sourceDir: string, targetDir: string): Promise<void> => {
  try {
    await mkdir(targetDir, { recursive: true });
  } catch (error) {
    throw new TemplateStoreError(
      "io_error",
      `could not create ${targetDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    throw new TemplateStoreError(
      "io_error",
      `could not list ${sourceDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(source, target);
      continue;
    }
    if (!entry.isFile()) {
      // The store refuses symlinks and special files on the way in; a tree that
      // has one now was changed after import, so the copy refuses it too.
      throw new TemplateStoreError("invalid_package", `'${source}' is not a regular file`);
    }
    try {
      await copyFile(source, target, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      throw new TemplateStoreError(
        "io_error",
        `could not copy ${source}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
};

const verifyExportedFiles = async (
  root: string,
  files: readonly TemplatePackageFile[],
): Promise<void> => {
  for (const file of files) {
    const target = path.join(root, "files", ...file.path.split("/"));
    let content: Buffer;
    try {
      content = await readFile(target);
    } catch (error) {
      throw new TemplateStoreError(
        "invalid_package",
        `the exported tree is missing '${file.path}'`,
        [`could not read ${target}: ${error instanceof Error ? error.message : String(error)}`],
      );
    }
    const digest = `sha256:${sha256(content)}`;
    if (digest !== file.digest || content.byteLength !== file.bytes) {
      throw new TemplateStoreError(
        "invalid_package",
        `the exported '${file.path}' does not match the manifest`,
        [
          `expected ${file.digest} (${String(file.bytes)} bytes), read ${digest} (${String(content.byteLength)} bytes)`,
        ],
      );
    }
  }
};

/**
 * Copy a stored `id@version` into `targetDir`, verifying every file it writes.
 *
 * `not_found` means the store does not hold the package; `target_exists` means
 * the destination was not free; `invalid_package` means the stored tree no
 * longer matches its manifest and nothing was left at the target.
 */
export const exportTemplatePackage = async (
  id: string,
  version: string,
  options: ExportTemplatePackageOptions,
): Promise<ExportTemplatePackageResult> => {
  const stored = await getTemplatePackage(id, version, options);
  const target = path.resolve(options.targetDir);
  const storedPath = path.resolve(stored.path);
  if (target === storedPath) {
    throw new TemplateStoreError("target_exists", `${target} is the stored package itself`);
  }
  if (isInside(storedPath, target)) {
    // The staging directory is a sibling of the target, so it would sit inside
    // the tree being copied and the copy would chase its own output.
    throw new TemplateStoreError("target_exists", `${target} is inside the stored package`);
  }
  const targetWasEmpty = await assertTargetIsFree(target);
  await mkdir(path.dirname(target), { recursive: true }).catch((error: unknown) => {
    throw new TemplateStoreError(
      "io_error",
      `could not create ${path.dirname(target)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (targetWasEmpty) {
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      throw new TemplateStoreError(
        "io_error",
        `could not clear ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const staging = path.join(
    path.dirname(target),
    `.${path.basename(target)}.export-${randomUUID()}`,
  );
  try {
    await copyTree(stored.path, staging);
    await verifyExportedFiles(staging, stored.files);
    await rename(staging, target);
  } catch (error) {
    let retained: string | undefined;
    await rm(staging, { recursive: true, force: true }).catch(() => {
      retained = staging;
    });
    if (retained !== undefined && error instanceof TemplateStoreError) {
      throw new TemplateStoreError(error.code, error.message, [
        ...error.details,
        `the staging directory ${retained} could not be removed`,
      ]);
    }
    throw error;
  }
  return {
    path: target,
    id: stored.id,
    version: stored.version,
    digest: stored.digest,
    files: stored.files,
    bytes: stored.files.reduce((total, file) => total + file.bytes, 0),
  };
};
