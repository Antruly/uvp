import { gunzipSync } from "node:zlib";

import { DEFAULT_TEMPLATE_PACKAGE_LIMITS } from "./templatePackage.js";

/**
 * The registry package archive: a deterministic gzipped tar of one package
 * directory.
 *
 * The registry publishes `archives/<id>/<version>.tgz` with the package
 * directory's contents at the archive root. This reader is intentionally small:
 * it accepts the ustar subset that archive contains and refuses everything else.
 * In particular it reads no symlinks, links, devices, directories, pax headers,
 * or GNU long-name records, and it never writes to disk. Extraction is a
 * separate step owned by the caller, which can then verify the declared
 * `files[]` digests before any byte reaches the store.
 *
 * ## Paths
 *
 * A tar header stores a path as `prefix` + "/" + `name`. The assembled path is
 * checked as a package-relative path: no absolute paths, drive letters,
 * backslashes, NUL bytes, or `.`/`..`/empty segments. Duplicate entries are
 * refused case-insensitively for the same reason the package format refuses
 * them: a case-insensitive filesystem would otherwise turn two entries into one.
 *
 * ## Bounds
 *
 * The caller has already bounded the compressed bytes. This module bounds the
 * decompressed output as well, so a gzip bomb cannot turn a small download into
 * unbounded memory: `maxFileBytes` bounds one entry, `maxBytes` their total, and
 * `maxFiles` the count. Header and padding overhead is added to the gunzip cap.
 */

export interface TemplateArchiveLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  /** The sum of the uncompressed file bytes. */
  readonly maxBytes: number;
}

/** The archive limits mirror the package limits they feed into the store. */
export const DEFAULT_TEMPLATE_ARCHIVE_LIMITS: TemplateArchiveLimits = {
  maxFiles: DEFAULT_TEMPLATE_PACKAGE_LIMITS.maxFiles,
  maxFileBytes: DEFAULT_TEMPLATE_PACKAGE_LIMITS.maxFileBytes,
  maxBytes: DEFAULT_TEMPLATE_PACKAGE_LIMITS.maxTotalBytes,
};

export interface TemplateArchiveEntry {
  readonly path: string;
  readonly bytes: Buffer;
}

export type TemplateArchiveErrorCode =
  | "corrupt"
  | "truncated"
  | "too_large"
  | "unsafe_path"
  | "duplicate_entry"
  | "unsupported_entry"
  | "unsupported_feature"
  | "too_many_files"
  | "file_too_large"
  | "total_too_large";

export class TemplateArchiveError extends Error {
  readonly code: TemplateArchiveErrorCode;
  /** Where the failure is: an entry index (and its path, when known), or `archive`. */
  readonly location: string;

  constructor(code: TemplateArchiveErrorCode, message: string, location: string) {
    super(message);
    this.name = "TemplateArchiveError";
    this.code = code;
    this.location = location;
  }
}

const BLOCK_SIZE = 512;
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_LENGTH = 8;
const TYPE_OFFSET = 156;
const MAGIC_OFFSET = 257;
const MAGIC_LENGTH = 5;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;

/** The ustar typeflags this reader accepts: a regular file, NUL or "0". */
const REGULAR_FILE_NUL = 0;
const REGULAR_FILE_ZERO = 0x30;

const TYPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "1": "hard link",
  "2": "symlink",
  "3": "character device",
  "4": "block device",
  "5": "directory",
  "6": "FIFO",
  "7": "contiguous file",
  x: "pax extended header",
  g: "global pax header",
  L: "GNU long name",
  K: "GNU long link",
};

const isZeroBlock = (block: Buffer): boolean => block.every((byte) => byte === 0);

/** Decode a NUL-terminated header field, refusing bytes hidden after the NUL. */
const readTextField = (field: Buffer, label: string, location: string): string => {
  const end = field.indexOf(0);
  if (end === -1) return field.toString("utf8");
  for (let index = end + 1; index < field.length; index += 1) {
    if (field[index] !== 0) {
      throw new TemplateArchiveError(
        "corrupt",
        `the ${label} field contains a NUL byte before its end`,
        location,
      );
    }
  }
  return field.subarray(0, end).toString("utf8");
};

const parseOctal = (field: Buffer, label: string, location: string): number => {
  const text = field.toString("latin1").replace(/^[\0 ]+|[\0 ]+$/gu, "");
  if (text === "") return 0;
  if (!/^[0-7]+$/u.test(text)) {
    throw new TemplateArchiveError("corrupt", `the ${label} field is not octal`, location);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw new TemplateArchiveError("corrupt", `the ${label} field is out of range`, location);
  }
  return value;
};

/** The unsigned ustar checksum: the block summed with the checksum field as spaces. */
const headerChecksum = (block: Buffer): number => {
  let sum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    const inChecksumField = index >= CHECKSUM_OFFSET && index < CHECKSUM_OFFSET + CHECKSUM_LENGTH;
    sum += inChecksumField ? 0x20 : (block[index] ?? 0);
  }
  return sum;
};

/**
 * Why the assembled path cannot name a package file, or undefined.
 *
 * The rules are the package format's portable-path rules in the form a tar
 * header can violate them. The store validates the same paths again; this
 * check exists so a traversal never even reaches the extraction directory.
 */
// These are the package format's portable-path refusals, applied to archive
// entry paths before any of them is written to the staging directory.
const NON_PORTABLE_CHARACTER = /[<>:"|?*]/u;
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const pathProblem = (value: string): string | undefined => {
  if (value === "") return "is empty";
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value)) {
    return "is absolute; archive entries must be relative to the package directory";
  }
  if (value.includes("\\")) return "contains a backslash";
  if (value.includes("\0")) return "contains a NUL byte";
  if (hasControlCharacter(value)) return "contains a control character";
  for (const segment of value.split("/")) {
    if (segment === "") return "contains an empty path segment";
    if (segment === ".") return "contains a '.' segment";
    if (segment === "..") return "contains a '..' segment";
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      return "has a segment ending in a dot or space, which Windows strips";
    }
    if (NON_PORTABLE_CHARACTER.test(segment)) {
      return "contains a character that is not portable to Windows";
    }
    if (RESERVED_DEVICE.test(segment)) {
      return `uses the reserved device name '${segment}'`;
    }
  }
  return undefined;
};

const typeflagProblem = (type: string): { code: TemplateArchiveErrorCode; problem: string } => {
  const description = TYPE_DESCRIPTIONS[type] ?? `typeflag '${type}'`;
  const extension = type === "x" || type === "g" || type === "L" || type === "K";
  return {
    code: extension ? "unsupported_feature" : "unsupported_entry",
    problem: `is a ${description}; only regular files are accepted`,
  };
};

interface ParsedHeader {
  readonly path: string;
  readonly size: number;
}

/** Verify one 512-byte header and return the path and size it declares. */
const parseHeader = (header: Buffer, index: number): ParsedHeader => {
  const location = `entries[${index}]`;
  const declaredChecksum = parseOctal(
    header.subarray(CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_LENGTH),
    "checksum",
    location,
  );
  if (headerChecksum(header) !== declaredChecksum) {
    throw new TemplateArchiveError(
      "corrupt",
      "the header checksum does not match its contents",
      location,
    );
  }
  if (header.subarray(MAGIC_OFFSET, MAGIC_OFFSET + MAGIC_LENGTH).toString("latin1") !== "ustar") {
    throw new TemplateArchiveError(
      "unsupported_feature",
      "the entry is not a ustar header",
      location,
    );
  }

  const rawType = header[TYPE_OFFSET] ?? REGULAR_FILE_NUL;
  if (rawType !== REGULAR_FILE_NUL && rawType !== REGULAR_FILE_ZERO) {
    const problem = typeflagProblem(String.fromCharCode(rawType));
    throw new TemplateArchiveError(problem.code, `the entry ${problem.problem}`, location);
  }

  const name = readTextField(
    header.subarray(NAME_OFFSET, NAME_OFFSET + NAME_LENGTH),
    "name",
    location,
  );
  const prefix = readTextField(
    header.subarray(PREFIX_OFFSET, PREFIX_OFFSET + PREFIX_LENGTH),
    "prefix",
    location,
  );
  const path = prefix === "" ? name : `${prefix}/${name}`;
  const unsafe = pathProblem(path);
  if (unsafe !== undefined) {
    throw new TemplateArchiveError("unsafe_path", `'${path}' ${unsafe}`, location);
  }

  const size = parseOctal(
    header.subarray(SIZE_OFFSET, SIZE_OFFSET + SIZE_LENGTH),
    "size",
    location,
  );
  return { path, size };
};

interface ReadContext {
  readonly limits: TemplateArchiveLimits;
  readonly seen: ReadonlySet<string>;
  readonly totalBytes: number;
}

/**
 * Read one ustar header and its data.
 *
 * Returns `undefined` at the end-of-archive marker. The archive's bytes are
 * returned as subarrays of the decompressed buffer, so the caller must not
 * assume they are independent copies.
 */
const readEntry = (
  tar: Buffer,
  offset: number,
  index: number,
  context: ReadContext,
): { readonly entry: TemplateArchiveEntry; readonly next: number } | undefined => {
  const location = `entries[${index}]`;
  if (offset + BLOCK_SIZE > tar.length) {
    throw new TemplateArchiveError(
      "truncated",
      offset === tar.length
        ? "the archive ends without an end-of-archive marker"
        : "the archive ends in the middle of a header",
      offset === tar.length ? "archive" : location,
    );
  }

  const header = tar.subarray(offset, offset + BLOCK_SIZE);
  if (isZeroBlock(header)) return undefined;
  const parsed = parseHeader(header, index);
  const entryPath = parsed.path;
  const size = parsed.size;

  if (context.seen.has(entryPath.toLowerCase())) {
    throw new TemplateArchiveError(
      "duplicate_entry",
      `'${entryPath}' appears more than once`,
      location,
    );
  }
  if (index + 1 > context.limits.maxFiles) {
    throw new TemplateArchiveError(
      "too_many_files",
      `the archive contains more than ${context.limits.maxFiles} files`,
      location,
    );
  }
  if (size > context.limits.maxFileBytes) {
    throw new TemplateArchiveError(
      "file_too_large",
      `'${entryPath}' declares ${size} bytes, more than the ${context.limits.maxFileBytes} allowed`,
      location,
    );
  }
  const nextTotal = context.totalBytes + size;
  if (nextTotal > context.limits.maxBytes) {
    throw new TemplateArchiveError(
      "total_too_large",
      `the archive's files declare ${nextTotal} bytes, more than the ${context.limits.maxBytes} allowed`,
      location,
    );
  }

  const dataStart = offset + BLOCK_SIZE;
  const dataEnd = dataStart + size;
  const next = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  if (next > tar.length) {
    throw new TemplateArchiveError(
      "truncated",
      `'${entryPath}' declares ${size} bytes but the archive ends early`,
      location,
    );
  }
  return { entry: { path: entryPath, bytes: tar.subarray(dataStart, dataEnd) }, next };
};

/**
 * Decompress and read a package archive in memory.
 *
 * Throws `TemplateArchiveError` for anything the archive is not allowed to be.
 * No directory is created and no file is written.
 */
export const extractTemplateArchive = (
  bytes: Uint8Array,
  limits: TemplateArchiveLimits = DEFAULT_TEMPLATE_ARCHIVE_LIMITS,
): readonly TemplateArchiveEntry[] => {
  // Each file costs one header and at most one block of padding; the end marker
  // is two blocks. The cap is deliberately loose only in that overhead.
  const maxOutputLength = limits.maxBytes + limits.maxFiles * BLOCK_SIZE * 2 + BLOCK_SIZE * 2;
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    if (code === "ERR_BUFFER_TOO_LARGE") {
      throw new TemplateArchiveError(
        "too_large",
        `the archive expands to more than ${maxOutputLength} bytes`,
        "archive",
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new TemplateArchiveError(
      "corrupt",
      `the archive is not a readable gzip stream: ${reason}`,
      "archive",
    );
  }

  const entries: TemplateArchiveEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let totalBytes = 0;
  for (;;) {
    const parsed = readEntry(tar, offset, entries.length, { limits, seen, totalBytes });
    if (parsed === undefined) break;
    entries.push(parsed.entry);
    seen.add(parsed.entry.path.toLowerCase());
    totalBytes += parsed.entry.bytes.byteLength;
    offset = parsed.next;
  }
  return entries;
};
