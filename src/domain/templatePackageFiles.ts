import {
  templatePackagePathProblem,
  type TemplatePackageFile,
  type TemplatePackageFileObservation,
  type TemplatePackageLimits,
} from "./templatePackage.js";
import { Problems, asInteger, asString, isRecord } from "./templatePackageProblems.js";

/**
 * The manifest's `files` list and the reader's observations of `files/`.
 *
 * A manifest declares what it thinks it ships; a reader reports what it found.
 * Neither is trusted alone: the declaration is checked against the path, format,
 * and size rules here, the observation against the declaration, and the two
 * lists against each other in both directions, so a manifest cannot declare a
 * file the tree lacks and a tree cannot carry a file the manifest omits.
 *
 * Observations are optional and partial on purpose. The two-way agreement
 * below runs only when a reader supplied a listing; without one the validator
 * has examined the declaration alone, and the result's `filesObserved` marker
 * says so rather than letting `ok` imply the tree matches. A listing that did
 * not report symlinks or binary-ness leaves those questions unexamined, and
 * this module does not turn "not examined" into "fine" — it checks only what
 * the reader observed. Whether the bytes on disk actually hash to the declared
 * digest is the reader's finding; a reader that supplies no digest has not made
 * that finding, and the validator does not pretend otherwise.
 */

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/**
 * The rule for a `sha256:` digest, exported so the registry index reader checks
 * a package digest with the same expression rather than a second copy of it.
 */
export const templatePackageDigestProblem = (value: string): string | undefined =>
  DIGEST_PATTERN.test(value)
    ? undefined
    : "must be 'sha256:' followed by 64 lowercase hex characters";
const ARCHIVE_EXTENSIONS = new Set(["7z", "gz", "rar", "tar", "tgz", "xz", "zip"]);
const EXECUTABLE_EXTENSIONS = new Set([
  "a",
  "bin",
  "class",
  "dll",
  "dylib",
  "exe",
  "lib",
  "o",
  "so",
]);
const FILE_KEYS = new Set(["path", "digest", "bytes"]);

const fileExtension = (path: string): string | undefined => {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : undefined;
};

function readFileEntry(
  entry: unknown,
  index: number,
  limits: TemplatePackageLimits,
  problems: Problems,
): TemplatePackageFile | undefined {
  const location = `files[${index}]`;
  if (!isRecord(entry)) {
    problems.add(location, "must be an object");
    return undefined;
  }
  problems.rejectUnknownKeys(entry, `${location}.`, FILE_KEYS);
  const path = asString(entry["path"]);
  const digest = asString(entry["digest"]);
  const bytes = asInteger(entry["bytes"]);
  if (path === undefined) problems.add(`${location}.path`, "must be a string");
  else {
    const problem = templatePackagePathProblem(path, limits);
    if (problem !== undefined) problems.add(`${location}.path`, problem);
    const extension = fileExtension(path);
    if (extension !== undefined && ARCHIVE_EXTENSIONS.has(extension)) {
      problems.add(`${location}.path`, "is an archive; extract it before packaging");
    } else if (extension !== undefined && EXECUTABLE_EXTENSIONS.has(extension)) {
      problems.add(
        `${location}.path`,
        "is an executable or object file; package source, not binaries",
      );
    }
  }
  if (digest === undefined) problems.add(`${location}.digest`, "must be a string");
  else {
    const problem = templatePackageDigestProblem(digest);
    if (problem !== undefined) problems.add(`${location}.digest`, problem);
  }
  if (bytes === undefined) problems.add(`${location}.bytes`, "must be an integer");
  else if (bytes < 0 || bytes > limits.maxFileBytes) {
    problems.add(`${location}.bytes`, `must be between 0 and ${limits.maxFileBytes}`);
  }
  return path === undefined || digest === undefined || bytes === undefined
    ? undefined
    : { path, digest, bytes };
}

export function readFiles(
  record: Record<string, unknown>,
  limits: TemplatePackageLimits,
  problems: Problems,
): readonly TemplatePackageFile[] | undefined {
  const files = record["files"];
  if (!Array.isArray(files)) {
    problems.add("files", "must be an array");
    return undefined;
  }
  if (files.length === 0) problems.add("files", "must list at least one file");
  if (files.length > limits.maxFiles) {
    problems.add("files", `must list at most ${limits.maxFiles} files`);
  }
  const parsed: TemplatePackageFile[] = [];
  const seen = new Map<string, number>();
  let total = 0;
  files.forEach((entry: unknown, index) => {
    const file = readFileEntry(entry, index, limits, problems);
    if (file === undefined) return;
    const key = file.path.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      problems.add(
        `files[${index}].path`,
        `duplicates files[${previous}].path (case-insensitively)`,
      );
      return;
    }
    seen.set(key, index);
    parsed.push(file);
    total += file.bytes;
  });
  if (total > limits.maxTotalBytes) {
    problems.add("files", `declares ${total} bytes, more than the ${limits.maxTotalBytes} allowed`);
  }
  return parsed;
}

const binaryOutsideAssets = (path: string): boolean =>
  !(path === "assets" || path.startsWith("assets/"));

export function compareObservations(
  files: readonly TemplatePackageFile[],
  observations: readonly TemplatePackageFileObservation[],
  limits: TemplatePackageLimits,
  problems: Problems,
): void {
  const declared = new Map(files.map((file) => [file.path, file]));
  const declaredCaseFolded = new Map(files.map((file) => [file.path.toLowerCase(), file]));
  const seen = new Map<string, number>();
  let total = 0;
  observations.forEach((observation, index) => {
    const location = `files[${index}]`;
    if (observation.symlink === true) {
      problems.add(location, "is a symlink; package files must be regular files");
    }
    const key = observation.path.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      problems.add(location, `duplicates files[${previous}] (case-insensitively)`);
    } else {
      seen.set(key, index);
    }
    total += observation.bytes;
    const file = declared.get(observation.path);
    if (file === undefined) {
      // Paths agree by exact case: a package extracted on Windows or macOS
      // would still produce the spelling the manifest has. A case-only
      // difference is reported as such rather than as an unrelated file, so
      // the caller knows the tree and the manifest name the same entry.
      const caseMatch = declaredCaseFolded.get(key);
      problems.add(
        location,
        caseMatch === undefined
          ? `'${observation.path}' is not listed in the manifest`
          : `differs only in case from the manifest's '${caseMatch.path}'; declare one spelling`,
      );
      return;
    }
    if (observation.bytes !== file.bytes) {
      problems.add(location, `is ${observation.bytes} bytes; the manifest declares ${file.bytes}`);
    }
    if (observation.digest !== undefined && observation.digest !== file.digest) {
      problems.add(location, "does not match the digest the manifest declares");
    }
    if (observation.binary === true && binaryOutsideAssets(observation.path)) {
      problems.add(location, "is binary and outside assets/; binary assets belong under assets/");
    }
  });
  if (total > limits.maxTotalBytes) {
    problems.add(
      "files",
      `the reader observed ${total} bytes, more than the ${limits.maxTotalBytes} allowed`,
    );
  }
  for (const file of files) {
    if (!seen.has(file.path.toLowerCase())) {
      problems.add("files", `lists '${file.path}' but the reader did not observe it`);
    }
  }
}
