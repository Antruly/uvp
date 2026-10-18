import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { canonicalJson, sha256 } from "../domain/identity.js";
import {
  DEFAULT_TEMPLATE_PACKAGE_LIMITS,
  parseTemplatePackageVersion,
  type TemplatePackageFile,
  type TemplatePackageFileObservation,
  type TemplatePackageLimits,
  type TemplatePackageManifest,
} from "../domain/templatePackage.js";
import { validateTemplatePackage } from "../domain/templatePackageManifest.js";
import { isRecord } from "../domain/templatePackageProblems.js";

/**
 * The local template store (P2 of #236).
 *
 * The store owns one directory tree per user:
 *
 *   <root>/<id>/<version>/        the package, exactly as imported
 *   <root>/.meta/<id>/<version>.json  what the import observed
 *   <root>/.tmp/                  staging for an atomic import
 *   <root>/.trash/                a replaced or removed tree, until cleanup
 *   <root>/.lock                  serializes mutations
 *
 * The package format and its rules are owned by `domain/templatePackage*`; this
 * module reads a directory into the observations that validator asks for, then
 * writes the same bytes into the store. It does not interpret the manifest a
 * second time.
 *
 * ## What is atomic and what is not
 *
 * An import validates the source first, copies to `.tmp`, re-validates the
 * copy, and only then renames it into place. A failed import leaves no package
 * and removes its staging directory; a failed cleanup is reported, not hidden.
 * A replace moves the old tree to `.trash` before the new rename, so a failed
 * rename can be rolled back; the trash is removed after the new tree is in
 * place, and a failed removal is returned as `retained`.
 *
 * Reads are not locked. A read that races a replace can see `not_found` for one
 * call; that is reported rather than retried into a stale answer.
 *
 * ## Q6: unverified local imports
 *
 * A strict import requires the manifest's licence and provenance. With
 * `allowUnverified`, a package whose only validation problems are in
 * `license`/`provenance` is accepted for local use, marked `unverified: true`,
 * and never presented as verified. The manifest on disk is the source's, not a
 * patched one; the marker is in the store metadata. The shared registry (#239)
 * does not use this path.
 */

export type TemplateStoreErrorCode =
  | "invalid_package"
  | "template_exists"
  | "not_found"
  | "store_locked"
  | "io_error";

export class TemplateStoreError extends Error {
  readonly code: TemplateStoreErrorCode;
  readonly details: readonly string[];

  constructor(code: TemplateStoreErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "TemplateStoreError";
    this.code = code;
    this.details = details;
  }
}

export interface StoredTemplatePackage {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly category: TemplatePackageManifest["category"];
  readonly framework?: TemplatePackageManifest["framework"];
  readonly tags?: readonly string[];
  readonly requires?: TemplatePackageManifest["requires"];
  readonly license?: TemplatePackageManifest["license"];
  readonly provenance?: TemplatePackageManifest["provenance"];
  readonly digest: string;
  readonly files: readonly TemplatePackageFile[];
  readonly preview?: string;
  readonly unverified: boolean;
  /** The directory this package occupies in the store. */
  readonly path: string;
}

export interface TemplateStoreOptions {
  /** Defaults to `resolveTemplateStoreRoot()`. */
  readonly storeRoot?: string;
  readonly limits?: TemplatePackageLimits;
  /** Mutations wait this long for the lock before failing. */
  readonly lockTimeoutMs?: number;
}

export interface ImportTemplatePackageOptions extends TemplateStoreOptions {
  readonly sourceDir: string;
  /** Replace an existing `id@version`; never implicit. */
  readonly replace?: boolean;
  /** Admit a package whose only problems are licence/provenance. */
  readonly allowUnverified?: boolean;
}

export interface ImportTemplatePackageResult {
  readonly package: StoredTemplatePackage;
  readonly replaced: boolean;
  /** A trash directory whose removal failed; the package is imported, cleanup is not complete. */
  readonly retained?: string;
}

export interface RemoveTemplatePackageResult {
  readonly removed: string;
  /** A trash directory whose removal failed. */
  readonly retained?: string;
}

export interface CorruptTemplatePackage {
  readonly path: string;
  readonly problems: readonly string[];
}

export interface ListTemplatePackagesResult {
  readonly packages: readonly StoredTemplatePackage[];
  readonly corrupt: readonly CorruptTemplatePackage[];
}

const STORE_METADATA_SCHEMA = "uvp.store/1";
const TOP_LEVEL_DIRECTORY = "files";
const TOP_LEVEL_FILES = new Set([
  "template.json",
  "README.md",
  "LICENSE",
  "preview.png",
  "preview.svg",
  "preview.webp",
]);
const PREVIEW_NAMES = new Set(["preview.png", "preview.svg", "preview.webp"]);
const LOCK_NAME = ".lock";
const TMP_NAME = ".tmp";
const TRASH_NAME = ".trash";
const META_NAME = ".meta";
const STALE_LOCK_MS = 10 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error["code"] === "string" ? error["code"] : undefined;

const ioError = (message: string, error: unknown): TemplateStoreError =>
  new TemplateStoreError("io_error", `${message}: ${errorCode(error) ?? String(error)}`);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isAbsent = (error: unknown): boolean => errorCode(error) === "ENOENT";

/** `$UVP_TEMPLATE_HOME`, else `~/.uvp/templates`, resolved absolutely. */
export const resolveTemplateStoreRoot = (
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string => {
  const configured = env["UVP_TEMPLATE_HOME"];
  return path.resolve(
    configured !== undefined && configured.trim() !== ""
      ? configured
      : path.join(home, ".uvp", "templates"),
  );
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isAbsent(error)) return false;
    throw ioError(`could not stat ${target}`, error);
  }
};

const ensureDirectory = async (target: string): Promise<void> => {
  try {
    await mkdir(target, { recursive: true });
  } catch (error) {
    throw ioError(`could not create ${target}`, error);
  }
};

/**
 * Run `operation` while holding `<root>/.lock`.
 *
 * `wx` is the atomic create: the first process wins. The wait is bounded; a
 * lock older than ten minutes is treated as abandoned and removed once, so a
 * crashed import does not block the store forever. The lock is removed in a
 * `finally`, and a failure to remove it is not allowed to replace the
 * operation's own result.
 */
const withStoreLock = async <T>(
  root: string,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> => {
  await ensureDirectory(root);
  const lockPath = path.join(root, LOCK_NAME);
  const deadline = Date.now() + timeoutMs;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw ioError(`could not take ${lockPath}`, error);
      if (Date.now() >= deadline) {
        const info = await stat(lockPath).catch(() => undefined);
        if (info !== undefined && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        throw new TemplateStoreError(
          "store_locked",
          `another template-store operation holds ${lockPath}`,
        );
      }
      await delay(25);
    }
  }
  if (handle === undefined) {
    throw new TemplateStoreError("store_locked", `could not take ${lockPath}`);
  }
  try {
    await handle.writeFile(`${String(process.pid)}\n${new Date().toISOString()}\n`);
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
};

interface ValidatedPackage {
  /** Structural manifest; for an unverified package, licence/provenance are placeholders. */
  readonly manifest: TemplatePackageManifest;
  readonly digest: string;
  readonly files: readonly TemplatePackageFile[];
  readonly unverified: boolean;
}

const invalid = (message: string, details: readonly string[] = []): TemplateStoreError =>
  new TemplateStoreError("invalid_package", message, details);

const problemsOf = (failure: {
  readonly problems: readonly { location: string; message: string }[];
}): readonly string[] =>
  failure.problems.map((problem) => `${problem.location}: ${problem.message}`);

const onlyTrustProblems = (problems: readonly { location: string; message: string }[]): boolean =>
  problems.every(
    (problem) =>
      problem.location === "license" ||
      problem.location.startsWith("license.") ||
      problem.location === "provenance" ||
      problem.location.startsWith("provenance."),
  );

interface FileWalk {
  readonly observations: readonly TemplatePackageFileObservation[];
}

const walkFiles = async (
  directory: string,
  relative: string,
  limits: TemplatePackageLimits,
  observations: TemplatePackageFileObservation[],
): Promise<void> => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw ioError(`could not list ${directory}`, error);
  }
  for (const entry of entries) {
    const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const child = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      observations.push({ path: childRelative, bytes: 0, symlink: true });
      continue;
    }
    if (entry.isDirectory()) {
      await walkFiles(child, childRelative, limits, observations);
      continue;
    }
    if (!entry.isFile()) {
      throw invalid(`'${childRelative}' is not a regular file`);
    }
    let content: Buffer;
    try {
      content = await readFile(child);
    } catch (error) {
      throw ioError(`could not read ${child}`, error);
    }
    if (content.byteLength > limits.maxFileBytes) {
      throw invalid(`'${childRelative}' is larger than ${limits.maxFileBytes} bytes`);
    }
    observations.push({
      path: childRelative,
      bytes: content.byteLength,
      digest: `sha256:${sha256(content)}`,
      binary: content.includes(0),
    });
    if (observations.length > limits.maxFiles) {
      throw invalid(`the package contains more than ${limits.maxFiles} files`);
    }
  }
};

const readTopLevel = async (
  sourceDir: string,
  manifest: Record<string, unknown>,
): Promise<ReadonlySet<string>> => {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    throw ioError(`could not list ${sourceDir}`, error);
  }
  const names = new Set<string>();
  for (const entry of entries) {
    names.add(entry.name);
    if (entry.name === TOP_LEVEL_DIRECTORY) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw invalid(`'files' must be a directory, not a link or file`);
      }
      continue;
    }
    if (!TOP_LEVEL_FILES.has(entry.name)) {
      throw invalid(`unexpected top-level entry '${entry.name}'`);
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw invalid(`'${entry.name}' must be a regular file`);
    }
  }
  if (!names.has("README.md")) throw invalid("README.md is required");
  const preview = manifest["preview"];
  if (typeof preview === "string" && !names.has(preview)) {
    throw invalid(`the manifest names preview '${preview}', but the package does not contain it`);
  }
  for (const name of PREVIEW_NAMES) {
    if (names.has(name) && preview !== name) {
      throw invalid(`'${name}' is present but not named by the manifest's preview field`);
    }
  }
  return names;
};

const readPackageDirectory = async (
  sourceDir: string,
  options: { limits: TemplatePackageLimits; allowUnverified: boolean },
): Promise<ValidatedPackage> => {
  const directoryInfo = await stat(sourceDir).catch((error: unknown) => {
    throw ioError(`could not stat ${sourceDir}`, error);
  });
  if (!directoryInfo.isDirectory()) throw invalid(`${sourceDir} is not a directory`);

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(sourceDir, "template.json"), "utf8"));
  } catch (error) {
    if (isAbsent(error)) throw invalid("template.json is missing");
    throw invalid(`template.json could not be read: ${errorCode(error) ?? String(error)}`);
  }
  if (!isRecord(raw)) throw invalid("template.json must contain an object");
  const names = await readTopLevel(sourceDir, raw);

  const observations: TemplatePackageFileObservation[] = [];
  const filesDir = path.join(sourceDir, TOP_LEVEL_DIRECTORY);
  if (!(await exists(filesDir))) throw invalid("files/ is missing");
  await walkFiles(filesDir, "", options.limits, observations);

  const validationOptions = {
    manifest: raw,
    files: observations,
    limits: options.limits,
  };
  const strict = validateTemplatePackage(validationOptions);
  if (strict.ok) {
    if (!names.has("LICENSE")) throw invalid("LICENSE is required");
    return {
      manifest: strict.manifest,
      digest: strict.digest,
      files: strict.manifest.files,
      unverified: false,
    };
  }

  if (!options.allowUnverified || !onlyTrustProblems(strict.problems)) {
    throw invalid("the package does not match uvp.template/1", problemsOf(strict));
  }

  // Q6: admit a package whose only missing/invalid metadata is licence and
  // provenance. Validate the rest against the same validator by supplying
  // placeholders; the source manifest stays untouched on disk.
  const patched = {
    ...raw,
    license: { name: "unverified", file: "LICENSE" },
    provenance: { author: "unverified", createdAt: new Date().toISOString() },
  };
  const relaxed = validateTemplatePackage({
    manifest: patched,
    files: observations,
    limits: options.limits,
  });
  if (!relaxed.ok) {
    throw invalid("the package does not match uvp.template/1", problemsOf(relaxed));
  }
  return {
    manifest: relaxed.manifest,
    digest: `sha256:${sha256(canonicalJson(raw))}`,
    files: relaxed.manifest.files,
    unverified: true,
  };
};

const toStored = (validated: ValidatedPackage, packagePath: string): StoredTemplatePackage => {
  const manifest = validated.manifest;
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    category: manifest.category,
    ...(manifest.framework === undefined ? {} : { framework: manifest.framework }),
    ...(manifest.tags === undefined ? {} : { tags: manifest.tags }),
    ...(manifest.requires === undefined ? {} : { requires: manifest.requires }),
    ...(validated.unverified || manifest.license === undefined
      ? {}
      : { license: manifest.license }),
    ...(validated.unverified || manifest.provenance === undefined
      ? {}
      : { provenance: manifest.provenance }),
    digest: validated.digest,
    files: validated.files,
    ...(manifest.preview === undefined ? {} : { preview: manifest.preview }),
    unverified: validated.unverified,
    path: packagePath,
  };
};

interface StoreMetadata {
  readonly digest: string;
  readonly unverified: boolean;
}

const metadataPath = (root: string, id: string, version: string): string =>
  path.join(root, META_NAME, id, `${version}.json`);

const readStoreMetadata = async (
  root: string,
  id: string,
  version: string,
): Promise<StoreMetadata | undefined> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(metadataPath(root, id, version), "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  if (raw["schema"] !== STORE_METADATA_SCHEMA) return undefined;
  if (raw["id"] !== id || raw["version"] !== version) return undefined;
  if (typeof raw["digest"] !== "string" || typeof raw["unverified"] !== "boolean") {
    return undefined;
  }
  return { digest: raw["digest"], unverified: raw["unverified"] };
};

interface StagedStoreMetadata {
  readonly id: string;
  readonly version: string;
  readonly temporary: string;
  readonly target: string;
}

/**
 * Write the metadata beside its destination without publishing it. Staging
 * happens before any tree move, so a metadata directory that cannot be written
 * fails the import while the store is still untouched.
 */
const stageStoreMetadata = async (
  root: string,
  id: string,
  version: string,
  metadata: StoreMetadata,
): Promise<StagedStoreMetadata> => {
  const directory = path.join(root, META_NAME, id);
  const target = metadataPath(root, id, version);
  const temporary = path.join(directory, `.${randomUUID()}.json`);
  try {
    await ensureDirectory(directory);
    await writeFile(
      temporary,
      `${JSON.stringify({
        schema: STORE_METADATA_SCHEMA,
        id,
        version,
        digest: metadata.digest,
        unverified: metadata.unverified,
        importedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw ioError(`could not stage metadata for ${id}@${version}`, error);
  }
  return { id, version, temporary, target };
};

/** Publish staged metadata; the caller rolls back the tree when this fails. */
const commitStoreMetadata = async (staged: StagedStoreMetadata): Promise<void> => {
  try {
    await rename(staged.temporary, staged.target);
  } catch (error) {
    await rm(staged.temporary, { force: true }).catch(() => undefined);
    throw ioError(`could not write metadata for ${staged.id}@${staged.version}`, error);
  }
};

const discardStoreMetadata = async (staged: StagedStoreMetadata): Promise<void> => {
  await rm(staged.temporary, { force: true }).catch(() => undefined);
};

/**
 * Drop a tree that was already renamed into place. The caller restores the
 * previous package separately; a failure here is left to that caller to report.
 */
const rollbackNewTree = async (target: string, staging: string): Promise<void> => {
  try {
    await rename(target, staging);
  } catch {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
};

const copyFileIfPresent = async (source: string, target: string): Promise<void> => {
  if (!(await exists(source))) return;
  try {
    await copyFile(source, target, fsConstants.COPYFILE_EXCL);
    await chmod(target, 0o644);
  } catch (error) {
    throw ioError(`could not copy ${source}`, error);
  }
};

const copyFilesTree = async (sourceDir: string, targetDir: string): Promise<void> => {
  await ensureDirectory(targetDir);
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    throw ioError(`could not list ${sourceDir}`, error);
  }
  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyFilesTree(source, target);
    } else if (entry.isFile()) {
      await copyFileIfPresent(source, target);
    }
  }
};

const copyPackage = async (sourceDir: string, targetDir: string): Promise<void> => {
  await ensureDirectory(targetDir);
  for (const name of ["template.json", "README.md", "LICENSE", ...PREVIEW_NAMES]) {
    await copyFileIfPresent(path.join(sourceDir, name), path.join(targetDir, name));
  }
  await copyFilesTree(
    path.join(sourceDir, TOP_LEVEL_DIRECTORY),
    path.join(targetDir, TOP_LEVEL_DIRECTORY),
  );
};

const safeSegment = (value: string): boolean =>
  value !== "" &&
  value !== "." &&
  value !== ".." &&
  !value.includes("/") &&
  !value.includes("\\") &&
  !value.includes("\0");

const assertIdentifier = (id: string, version?: string): void => {
  if (!safeSegment(id)) throw new TemplateStoreError("not_found", `no package '${id}'`);
  if (
    version !== undefined &&
    (!safeSegment(version) || parseTemplatePackageVersion(version) === undefined)
  ) {
    throw new TemplateStoreError("not_found", `no package '${id}@${version}'`);
  }
};

/** Import a package directory into the local store. */
export const importTemplatePackage = async (
  options: ImportTemplatePackageOptions,
): Promise<ImportTemplatePackageResult> => {
  const root = options.storeRoot ?? resolveTemplateStoreRoot();
  const limits = options.limits ?? DEFAULT_TEMPLATE_PACKAGE_LIMITS;
  const sourceDir = path.resolve(options.sourceDir);
  const validated = await readPackageDirectory(sourceDir, {
    limits,
    allowUnverified: options.allowUnverified === true,
  });
  const { id, version } = validated.manifest;
  const target = path.join(root, id, version);
  if (path.resolve(sourceDir) === path.resolve(target)) {
    throw invalid("the source is already this package's store entry");
  }

  return withStoreLock(root, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, async () => {
    const targetExists = await exists(target);
    if (targetExists && options.replace !== true) {
      throw new TemplateStoreError(
        "template_exists",
        `${id}@${version} is already in the store; pass replace to replace it`,
      );
    }

    const staging = path.join(root, TMP_NAME, randomUUID());
    await ensureDirectory(path.join(root, TMP_NAME));
    let retained: string | undefined;
    let replaced = false;
    let stagedMetadata: StagedStoreMetadata | undefined;
    try {
      await copyPackage(sourceDir, staging);
      const staged = await readPackageDirectory(staging, {
        limits,
        allowUnverified: options.allowUnverified === true,
      });
      await ensureDirectory(path.dirname(target));
      // Stage metadata before moving any tree: a metadata directory that
      // cannot be written fails the import while the store is still untouched.
      stagedMetadata = await stageStoreMetadata(root, id, version, {
        digest: staged.digest,
        unverified: staged.unverified,
      });

      if (targetExists) {
        const trash = path.join(root, TRASH_NAME, randomUUID());
        await ensureDirectory(path.join(root, TRASH_NAME));
        try {
          await rename(target, trash);
          replaced = true;
          try {
            await rename(staging, target);
          } catch (error) {
            await rename(trash, target).catch(() => undefined);
            throw ioError(`could not move ${staging} into place`, error);
          }
          try {
            await commitStoreMetadata(stagedMetadata);
          } catch (error) {
            // The old tree is still in trash and its metadata is untouched.
            // Put the old package back and drop the new tree, so a failed
            // replace neither reports success nor loses the previous version.
            await rollbackNewTree(target, staging);
            await rename(trash, target).catch(() => {
              retained = trash;
            });
            throw retained === undefined
              ? error
              : ioError(
                  `could not restore ${target}; the previous package remains at ${trash}`,
                  error,
                );
          }
          await rm(trash, { recursive: true, force: true }).catch(() => {
            retained = trash;
          });
        } catch (error) {
          if (error instanceof TemplateStoreError) throw error;
          throw ioError(`could not replace ${target}`, error);
        }
      } else {
        try {
          await rename(staging, target);
        } catch (error) {
          throw ioError(`could not move ${staging} into place`, error);
        }
        try {
          await commitStoreMetadata(stagedMetadata);
        } catch (error) {
          // Removing the tree keeps the promised invariant: a failed import
          // leaves no package. A cleanup failure is named, not hidden.
          await rm(target, { recursive: true, force: true }).catch(() => {
            retained = target;
          });
          throw retained === undefined
            ? error
            : ioError(`could not remove ${target} after a failed metadata write`, error);
        }
      }

      return {
        package: toStored(staged, target),
        replaced,
        ...(retained === undefined ? {} : { retained }),
      };
    } finally {
      if (stagedMetadata !== undefined) await discardStoreMetadata(stagedMetadata);
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  });
};

/** Read one stored package; `not_found` and `invalid_package` are distinct. */
export const getTemplatePackage = async (
  id: string,
  version: string,
  options: TemplateStoreOptions = {},
): Promise<StoredTemplatePackage> => {
  assertIdentifier(id, version);
  const root = options.storeRoot ?? resolveTemplateStoreRoot();
  const target = path.join(root, id, version);
  if (!(await exists(target))) {
    throw new TemplateStoreError("not_found", `${id}@${version} is not in the store`);
  }
  const metadata = await readStoreMetadata(root, id, version);
  const validated = await readPackageDirectory(target, {
    limits: options.limits ?? DEFAULT_TEMPLATE_PACKAGE_LIMITS,
    allowUnverified: metadata?.unverified === true,
  });
  return toStored(validated, target);
};

/** Every readable package, plus entries the reader refused. */
export const listTemplatePackages = async (
  options: TemplateStoreOptions = {},
): Promise<ListTemplatePackagesResult> => {
  const root = options.storeRoot ?? resolveTemplateStoreRoot();
  if (!(await exists(root))) return { packages: [], corrupt: [] };
  let ids;
  try {
    ids = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw ioError(`could not list ${root}`, error);
  }
  const packages: StoredTemplatePackage[] = [];
  const corrupt: CorruptTemplatePackage[] = [];
  for (const entry of ids) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const idDir = path.join(root, entry.name);
    let versions;
    try {
      versions = await readdir(idDir, { withFileTypes: true });
    } catch (error) {
      corrupt.push({
        path: idDir,
        problems: [`could not list: ${errorCode(error) ?? String(error)}`],
      });
      continue;
    }
    for (const versionEntry of versions) {
      if (!versionEntry.isDirectory() || versionEntry.isSymbolicLink()) continue;
      const packagePath = path.join(idDir, versionEntry.name);
      const metadata = await readStoreMetadata(root, entry.name, versionEntry.name);
      try {
        const validated = await readPackageDirectory(packagePath, {
          limits: options.limits ?? DEFAULT_TEMPLATE_PACKAGE_LIMITS,
          allowUnverified: metadata?.unverified === true,
        });
        packages.push(toStored(validated, packagePath));
      } catch (error) {
        corrupt.push({
          path: packagePath,
          problems:
            error instanceof TemplateStoreError && error.details.length > 0
              ? [...error.details]
              : [error instanceof Error ? error.message : String(error)],
        });
      }
    }
  }
  packages.sort((left, right) =>
    left.id === right.id
      ? left.version.localeCompare(right.version)
      : left.id.localeCompare(right.id),
  );
  return { packages, corrupt };
};

/** Remove one version, or a package id's whole tree when `version` is omitted. */
export const removeTemplatePackage = async (
  id: string,
  version?: string,
  options: TemplateStoreOptions = {},
): Promise<RemoveTemplatePackageResult> => {
  assertIdentifier(id, version);
  const root = options.storeRoot ?? resolveTemplateStoreRoot();
  return withStoreLock(root, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, async () => {
    const target = version === undefined ? path.join(root, id) : path.join(root, id, version);
    if (!(await exists(target))) {
      throw new TemplateStoreError(
        "not_found",
        `${id}${version === undefined ? "" : `@${version}`} is not in the store`,
      );
    }
    const trash = path.join(root, TRASH_NAME, randomUUID());
    await ensureDirectory(path.join(root, TRASH_NAME));
    try {
      await rename(target, trash);
    } catch (error) {
      throw ioError(`could not remove ${target}`, error);
    }
    const metadata =
      version === undefined ? path.join(root, META_NAME, id) : metadataPath(root, id, version);
    await rm(metadata, { recursive: true, force: true }).catch(() => undefined);
    let retained: string | undefined;
    await rm(trash, { recursive: true, force: true }).catch(() => {
      retained = trash;
    });
    return { removed: target, ...(retained === undefined ? {} : { retained }) };
  });
};
