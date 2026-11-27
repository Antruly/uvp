import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256 } from "../domain/identity.js";
import {
  DEFAULT_TEMPLATE_ARCHIVE_LIMITS,
  TemplateArchiveError,
  extractTemplateArchive,
  type TemplateArchiveEntry,
} from "../domain/templateArchive.js";
import { parseTemplatePackageVersion } from "../domain/templatePackage.js";
import type {
  TemplateRegistryArchive,
  TemplateRegistryIndex,
  TemplateRegistryVersion,
} from "../domain/templateRegistry.js";
import {
  DEFAULT_TEMPLATE_REGISTRY_TIMEOUT_MS,
  TemplateRegistryError,
  defaultTemplateRegistryTransport,
  readTemplateRegistryIndex,
  resolveTemplateRegistryCacheRoot,
  type TemplateRegistryIndexRead,
  type TemplateRegistryOptions,
  type TemplateRegistryResponse,
  type TemplateRegistryTransport,
} from "./TemplateRegistry.js";
import {
  importTemplatePackage,
  type ImportTemplatePackageResult,
  type StoredTemplatePackage,
} from "./TemplateStore.js";

/**
 * Download, verify, extract, and import one registry package archive (#298).
 *
 * ## The order that matters
 *
 * Nothing untrusted is imported. The archive is verified against the index's
 * `archive.digest` and byte count before it is decompressed; the extracted
 * `files[]` entries are verified against the index's per-file digest and byte
 * count before they are written to a staging directory; and the staging
 * directory is handed to `importTemplatePackage`, which validates the package
 * again and owns the store's atomic write. A corrupted archive never reaches
 * the store, and a corrupted file never becomes a stored package.
 *
 * ## The three states
 *
 * - **network** — the index and the archive were both read now;
 * - **cache** — at least one of them came from the local cache. When a network
 *   read failed, `staleReason` names that failure; an explicit `offline` read
 *   of a valid cache is not called stale, matching the index reader;
 * - **undetermined** — the index or a digest-matching archive could not be
 *   obtained. This is never "the package does not exist".
 *
 * ## Bounds
 *
 * The download is capped at the archive's declared byte count and aborted
 * after `timeoutMs`; extraction is bounded by the package limits through
 * `extractTemplateArchive`. The cache is keyed by `<id>/<version>` because a
 * version archive is immutable, and it is reused only when its digest matches
 * the index entry for this read.
 */

export type TemplateRegistryFetchErrorCode =
  | "invalid_coordinates"
  | "package_not_found"
  | "archive_missing"
  | "archive_url"
  | "archive_size"
  | "archive_digest"
  | "archive_invalid"
  | "file_missing"
  | "file_digest"
  | "temp_io"
  | "import_failed";

export class TemplateRegistryFetchError extends Error {
  readonly code: TemplateRegistryFetchErrorCode;
  /** The index field, archive path, or `files[i].path` the failure belongs to. */
  readonly location: string;
  readonly details: readonly string[];

  constructor(
    code: TemplateRegistryFetchErrorCode,
    message: string,
    options: { readonly location: string; readonly details?: readonly string[] },
  ) {
    super(message);
    this.name = "TemplateRegistryFetchError";
    this.code = code;
    this.location = options.location;
    this.details = options.details ?? [];
  }
}

export interface FetchTemplateRegistryPackageOptions {
  readonly id: string;
  readonly version: string;
  readonly indexUrl?: string;
  readonly transport?: TemplateRegistryTransport;
  /** Defaults to `<template store root>/.registry`, as the index reader does. */
  readonly cacheRoot?: string;
  /** Defaults to the local template store. */
  readonly storeRoot?: string;
  /** Replace an existing `id@version`; never implicit. */
  readonly replace?: boolean;
  /** Skip both network reads and use only the cached index and archive. */
  readonly offline?: boolean;
  readonly timeoutMs?: number;
}

export interface TemplateRegistryFetchSuccess {
  readonly state: "network" | "cache";
  readonly package: StoredTemplatePackage;
  /** Why a cached answer was used; absent for a fully fresh or explicit offline read. */
  readonly staleReason?: string;
  readonly details?: readonly string[];
}

export interface TemplateRegistryFetchUndetermined {
  readonly state: "undetermined";
  readonly reason: string;
  readonly details: readonly string[];
}

export type TemplateRegistryFetchResult =
  | TemplateRegistryFetchSuccess
  | TemplateRegistryFetchUndetermined;

const SAFE_SEGMENT = /^(?!\.{1,2}$)[^/\\\0]+$/u;

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "the request timed out";
    }
    return error.message;
  }
  return String(error);
};

const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

const assertCoordinates = (id: string, version: string): void => {
  if (
    !SAFE_SEGMENT.test(id) ||
    !SAFE_SEGMENT.test(version) ||
    parseTemplatePackageVersion(version) === undefined
  ) {
    throw new TemplateRegistryFetchError(
      "invalid_coordinates",
      `'${id}@${version}' is not a package coordinate the store can hold`,
      { location: "id/version" },
    );
  }
};

const indexOptionsOf = (options: FetchTemplateRegistryPackageOptions): TemplateRegistryOptions => ({
  ...(options.indexUrl === undefined ? {} : { indexUrl: options.indexUrl }),
  ...(options.transport === undefined ? {} : { transport: options.transport }),
  ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
  ...(options.offline === undefined ? {} : { offline: options.offline }),
  ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
});

const findVersion = (
  index: TemplateRegistryIndex,
  id: string,
  version: string,
): TemplateRegistryVersion | undefined =>
  index.packages.find((pkg) => pkg.id === id)?.versions.find((entry) => entry.version === version);

/** Resolve the index's repository-relative archive path against the index URL. */
const resolveArchiveUrl = (archivePath: string, indexUrl: string): URL => {
  let url: URL;
  try {
    url = new URL(archivePath, indexUrl);
  } catch {
    throw new TemplateRegistryFetchError(
      "archive_url",
      `'${archivePath}' cannot be resolved against '${indexUrl}'`,
      { location: "archive.path" },
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TemplateRegistryFetchError(
      "archive_url",
      `'${url.toString()}' is not an http or https URL`,
      { location: "archive.path" },
    );
  }
  return url;
};

export const templateArchiveCachePath = (cacheRoot: string, id: string, version: string): string =>
  path.join(cacheRoot, "archives", id, `${version}.tgz`);

type ArchiveDownload =
  | { readonly kind: "downloaded"; readonly bytes: Buffer }
  | {
      readonly kind: "network_failure";
      readonly reason: string;
      readonly details: readonly string[];
    };

interface DownloadArchiveOptions {
  readonly url: string;
  readonly archive: TemplateRegistryArchive;
  readonly transport: TemplateRegistryTransport;
  readonly timeoutMs: number;
}

/**
 * Download one archive and verify its digest and byte count.
 *
 * Transport failures (unreachable, HTTP status, timeout, an oversized body) are
 * returned so the caller can fall back to a verified cache. A body that arrived
 * intact but does not match the index is an integrity failure and throws: a
 * digest mismatch is not a reason to trust some older bytes instead.
 */
const downloadArchive = async (options: DownloadArchiveOptions): Promise<ArchiveDownload> => {
  let response: TemplateRegistryResponse;
  try {
    response = await options.transport({
      url: options.url,
      maxBytes: options.archive.bytes,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    if (error instanceof TemplateRegistryError) {
      return {
        kind: "network_failure",
        reason: error.message,
        details: [error.code, ...error.details],
      };
    }
    const code = codeOf(error);
    return {
      kind: "network_failure",
      reason: describeError(error),
      details: code === undefined ? [] : [code],
    };
  }
  if (response.status !== 200) {
    return {
      kind: "network_failure",
      reason: `the registry answered HTTP ${response.status} for '${options.url}'`,
      details: [],
    };
  }
  if (response.body.byteLength !== options.archive.bytes) {
    throw new TemplateRegistryFetchError(
      "archive_size",
      `the archive at '${options.url}' is ${response.body.byteLength} bytes; the index declares ${options.archive.bytes}`,
      {
        location: "archive.bytes",
        details: [
          `${options.url}: observed ${response.body.byteLength} byte(s), index declares ${options.archive.bytes}`,
        ],
      },
    );
  }
  const digest = `sha256:${sha256(response.body)}`;
  if (digest !== options.archive.digest) {
    throw new TemplateRegistryFetchError(
      "archive_digest",
      `the archive at '${options.url}' has digest ${digest}; the index declares ${options.archive.digest}`,
      {
        location: "archive.digest",
        details: [`${options.url}: observed ${digest}, index declares ${options.archive.digest}`],
      },
    );
  }
  return { kind: "downloaded", bytes: response.body };
};

type CachedArchive =
  | { readonly kind: "read"; readonly bytes: Buffer }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Read the cached archive only if it is exactly the archive this index entry
 * names. A version archive is immutable, so a digest match makes the cached
 * bytes the same bytes the network would have served.
 */
const readCachedArchive = async (
  cachePath: string,
  archive: TemplateRegistryArchive,
): Promise<CachedArchive> => {
  let info;
  try {
    info = await stat(cachePath);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return { kind: "absent" };
    return {
      kind: "invalid",
      reason: `the cached archive at ${cachePath} could not be stat'ed: ${describeError(error)}`,
    };
  }
  if (!info.isFile()) {
    return { kind: "invalid", reason: `the cached archive at ${cachePath} is not a regular file` };
  }
  if (info.size !== archive.bytes) {
    return {
      kind: "invalid",
      reason: `the cached archive at ${cachePath} is ${info.size} bytes; the index declares ${archive.bytes}`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(cachePath);
  } catch (error) {
    return {
      kind: "invalid",
      reason: `the cached archive at ${cachePath} could not be read: ${describeError(error)}`,
    };
  }
  // `stat` and `readFile` are two observations; the file could have been
  // replaced between them. Re-check both facts the digest implies.
  if (bytes.byteLength !== archive.bytes) {
    return {
      kind: "invalid",
      reason: `the cached archive at ${cachePath} is ${bytes.byteLength} bytes; the index declares ${archive.bytes}`,
    };
  }
  const digest = `sha256:${sha256(bytes)}`;
  if (digest !== archive.digest) {
    return {
      kind: "invalid",
      reason: `the cached archive at ${cachePath} has digest ${digest}; the index declares ${archive.digest}`,
    };
  }
  return { kind: "read", bytes };
};

/** Write the verified archive through a temporary file and a rename. */
const writeArchiveCache = async (cachePath: string, bytes: Buffer): Promise<string | undefined> => {
  const directory = path.dirname(cachePath);
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, bytes);
    await rename(temporary, cachePath);
    return undefined;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    return `the archive could not be cached at ${cachePath}: ${describeError(error)}`;
  }
};

const cachedArchiveDetail = (cached: CachedArchive, cachePath: string): string =>
  cached.kind === "absent"
    ? `no cached archive exists at ${cachePath}`
    : cached.kind === "invalid"
      ? cached.reason
      : "";

interface ObtainArchiveOptions {
  readonly url: string;
  readonly archive: TemplateRegistryArchive;
  readonly transport: TemplateRegistryTransport;
  readonly timeoutMs: number;
  readonly cachePath: string;
  readonly offline: boolean;
}

type ObtainArchiveResult =
  | {
      readonly kind: "obtained";
      readonly bytes: Buffer;
      readonly source: "network" | "cache";
      readonly staleReason?: string;
      readonly details: readonly string[];
    }
  | { readonly kind: "undetermined"; readonly reason: string; readonly details: readonly string[] };

const obtainArchive = async (options: ObtainArchiveOptions): Promise<ObtainArchiveResult> => {
  if (options.offline) {
    const cached = await readCachedArchive(options.cachePath, options.archive);
    if (cached.kind === "read") {
      return { kind: "obtained", bytes: cached.bytes, source: "cache", details: [] };
    }
    return {
      kind: "undetermined",
      reason:
        cached.kind === "absent"
          ? "the client is offline and no cached archive exists"
          : "the client is offline and the cached archive is not usable",
      details: [cachedArchiveDetail(cached, options.cachePath)],
    };
  }

  const download = await downloadArchive({
    url: options.url,
    archive: options.archive,
    transport: options.transport,
    timeoutMs: options.timeoutMs,
  });
  if (download.kind === "downloaded") {
    const cacheError = await writeArchiveCache(options.cachePath, download.bytes);
    return {
      kind: "obtained",
      bytes: download.bytes,
      source: "network",
      details: cacheError === undefined ? [] : [cacheError],
    };
  }

  const cached = await readCachedArchive(options.cachePath, options.archive);
  if (cached.kind === "read") {
    return {
      kind: "obtained",
      bytes: cached.bytes,
      source: "cache",
      staleReason: `the archive download failed: ${download.reason}`,
      details: download.details,
    };
  }
  return {
    kind: "undetermined",
    reason: download.reason,
    details: [...download.details, cachedArchiveDetail(cached, options.cachePath)],
  };
};

const extractArchive = (bytes: Buffer, archivePath: string): readonly TemplateArchiveEntry[] => {
  try {
    return extractTemplateArchive(bytes, DEFAULT_TEMPLATE_ARCHIVE_LIMITS);
  } catch (error) {
    if (error instanceof TemplateArchiveError) {
      throw new TemplateRegistryFetchError(
        "archive_invalid",
        `the archive '${archivePath}' could not be extracted: ${error.message}`,
        {
          location: archivePath,
          details: [`${error.location}: ${error.message}`],
        },
      );
    }
    throw error;
  }
};

/**
 * Verify every file the index declares against the extracted bytes, before any
 * of them is written. The location names the `files[i].path`, so a failure says
 * which declaration was not met rather than only that "the archive is bad".
 */
const verifyDeclaredFiles = (
  entry: TemplateRegistryVersion,
  archivePath: string,
  entries: readonly TemplateArchiveEntry[],
): void => {
  const extracted = new Map(entries.map((item) => [item.path, item.bytes]));
  entry.files.forEach((file, index) => {
    const archiveEntry = `files/${file.path}`;
    const bytes = extracted.get(archiveEntry);
    if (bytes === undefined) {
      throw new TemplateRegistryFetchError(
        "file_missing",
        `the archive '${archivePath}' does not contain '${archiveEntry}'`,
        { location: `files[${index}].path` },
      );
    }
    const digest = `sha256:${sha256(bytes)}`;
    if (bytes.byteLength !== file.bytes || digest !== file.digest) {
      throw new TemplateRegistryFetchError(
        "file_digest",
        `'${archiveEntry}' in the archive '${archivePath}' is ${bytes.byteLength} byte(s) with digest ${digest}; the index declares ${file.bytes} byte(s) with digest ${file.digest}`,
        {
          location: `files[${index}].path`,
          details: [
            `${archiveEntry}: observed ${bytes.byteLength} byte(s) with digest ${digest}, ` +
              `index declares ${file.bytes} byte(s) with digest ${file.digest}`,
          ],
        },
      );
    }
  });
};

const writeExtracted = async (
  root: string,
  entries: readonly TemplateArchiveEntry[],
): Promise<void> => {
  for (const entry of entries) {
    const target = path.join(root, entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.bytes);
  }
};

const removeTemporaryDirectory = async (directory: string): Promise<string | undefined> => {
  try {
    await rm(directory, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return `the temporary extraction directory ${directory} could not be removed: ${describeError(error)}`;
  }
};

interface StageAndImportOptions {
  readonly entries: readonly TemplateArchiveEntry[];
  readonly archivePath: string;
  readonly storeRoot?: string;
  readonly replace?: boolean;
}

interface StagedImport {
  readonly package: StoredTemplatePackage;
  /** A failed cleanup of the staging directory; the import itself succeeded. */
  readonly cleanupFailure?: string;
}

/**
 * Write the verified entries to a fresh staging directory, import them, and
 * remove the directory however the import ends. The store validates the tree
 * again and owns the atomic move into `<storeRoot>/<id>/<version>`.
 */
const stageAndImport = async (options: StageAndImportOptions): Promise<StagedImport> => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "uvp-registry-archive-"));
  let imported: ImportTemplatePackageResult | undefined;
  let failure: Error | undefined;
  let cleanupFailure: string | undefined;
  try {
    try {
      await writeExtracted(temporaryDirectory, options.entries);
    } catch (error) {
      throw new TemplateRegistryFetchError(
        "temp_io",
        `could not stage the archive '${options.archivePath}' for import`,
        { location: options.archivePath, details: [describeError(error)] },
      );
    }
    imported = await importTemplatePackage({
      sourceDir: temporaryDirectory,
      ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
      ...(options.replace === undefined ? {} : { replace: options.replace }),
    });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    cleanupFailure = await removeTemporaryDirectory(temporaryDirectory);
  }
  if (failure !== undefined) throw failure;
  if (imported === undefined) {
    throw new TemplateRegistryFetchError(
      "import_failed",
      `the archive '${options.archivePath}' was staged but the import returned no package`,
      { location: options.archivePath },
    );
  }
  return {
    package: imported.package,
    ...(cleanupFailure === undefined ? {} : { cleanupFailure }),
  };
};

const staleReasonOf = (
  read: TemplateRegistryIndexRead,
  obtained: { readonly staleReason?: string },
): string | undefined => {
  const reasons = [
    ...(read.source === "cache" && read.staleReason !== undefined
      ? [`the index is stale: ${read.staleReason}`]
      : []),
    ...(obtained.staleReason === undefined ? [] : [obtained.staleReason]),
  ];
  return reasons.length === 0 ? undefined : reasons.join("; ");
};

/**
 * Fetch one exact `id@version`, verify it, and import it into the local store.
 *
 * The returned `state` describes the read, not the import: a package is only
 * returned when the import succeeded.
 */
export const fetchTemplateRegistryPackage = async (
  options: FetchTemplateRegistryPackageOptions,
): Promise<TemplateRegistryFetchResult> => {
  assertCoordinates(options.id, options.version);

  const read = await readTemplateRegistryIndex(indexOptionsOf(options));
  if (read.state === "undetermined") {
    return { state: "undetermined", reason: read.reason, details: read.details };
  }

  const entry = findVersion(read.index, options.id, options.version);
  if (entry === undefined) {
    throw new TemplateRegistryFetchError(
      "package_not_found",
      `the registry index does not list ${options.id}@${options.version}`,
      { location: `packages['${options.id}'].versions['${options.version}']` },
    );
  }
  const archive = entry.archive;
  if (archive === undefined) {
    throw new TemplateRegistryFetchError(
      "archive_missing",
      `${options.id}@${options.version} has no published archive`,
      {
        location: `packages['${options.id}'].versions['${options.version}'].archive`,
      },
    );
  }

  const archiveUrl = resolveArchiveUrl(archive.path, read.url);
  const cachePath = templateArchiveCachePath(
    resolveTemplateRegistryCacheRoot(options.cacheRoot),
    options.id,
    options.version,
  );
  const obtained = await obtainArchive({
    url: archiveUrl.toString(),
    archive,
    transport: options.transport ?? defaultTemplateRegistryTransport,
    timeoutMs: options.timeoutMs ?? DEFAULT_TEMPLATE_REGISTRY_TIMEOUT_MS,
    cachePath,
    offline: options.offline === true,
  });
  if (obtained.kind === "undetermined") {
    return { state: "undetermined", reason: obtained.reason, details: obtained.details };
  }

  const entries = extractArchive(obtained.bytes, archive.path);
  verifyDeclaredFiles(entry, archive.path, entries);
  const staged = await stageAndImport({
    entries,
    archivePath: archive.path,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    ...(options.replace === undefined ? {} : { replace: options.replace }),
  });

  const staleReason = staleReasonOf(read, obtained);
  const details = [
    ...obtained.details,
    ...(staged.cleanupFailure === undefined ? [] : [staged.cleanupFailure]),
  ];

  return {
    state: read.source === "network" && obtained.source === "network" ? "network" : "cache",
    package: staged.package,
    ...(staleReason === undefined ? {} : { staleReason }),
    ...(details.length === 0 ? {} : { details }),
  };
};
