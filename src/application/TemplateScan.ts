import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { TemplateStoreError } from "./TemplateStore.js";

/**
 * The bounded, heuristic secret/PII scan for template packages (P4 of #236).
 *
 * ## What it is, and what it is not
 *
 * It reads the bytes under a package directory as text and reports shapes that
 * commonly hold credentials or personal data: private-key blocks, provider
 * tokens, `.env`-style secret assignments, absolute home paths, email addresses,
 * and international phone numbers. It does not prove a package is clean. A
 * finding says "look here"; the absence of findings says "these patterns did
 * not match in the bytes that were read", and the result carries the exact set
 * that was read so a caller cannot mistake one for the other.
 *
 * Nothing is executed, no network request is made, and no package script is
 * consulted. The scan is over bytes on disk. Every match on a line is reported,
 * not only the first, and a `.git` directory is named as skipped rather than
 * scanned so repository metadata does not become a finding.
 *
 * ## Bounds
 *
 * Each file is `stat`ed before it is read, so the per-file and total limits
 * bound memory as well as the answer; a file larger than the limit is skipped
 * and named, never read. Binary files (a NUL byte) are skipped by name. The
 * findings list is capped: when the cap is reached the walk stops recording and
 * sets `truncated`, and files not examined are reported with a reason. `scanned`
 * is exactly the set of files this call read.
 *
 * ## Redaction
 *
 * A finding never repeats the value it matched. `redacted` keeps enough of the
 * shape to recognise the pattern (a token's first characters, an email's domain,
 * a home path's root) and nothing that would itself leak the credential or the
 * personal data into a log or a tool result.
 */

export type TemplateScanRule =
  | "private_key"
  | "aws_access_key"
  | "github_token"
  | "slack_token"
  | "provider_token"
  | "secret_assignment"
  | "home_path"
  | "email"
  | "phone";

/** Whether a finding is a credential or personal data. */
export type TemplateScanFindingKind = "credential" | "pii";

export interface TemplateScanFinding {
  /** Relative to the scanned directory, `/`-separated. */
  readonly path: string;
  /** 1-based line in the file as read (UTF-8 decoded). */
  readonly line: number;
  readonly rule: TemplateScanRule;
  readonly kind: TemplateScanFindingKind;
  /** The matched shape with the sensitive part masked. Never the secret itself. */
  readonly redacted: string;
}

export interface TemplateScanSkip {
  readonly path: string;
  readonly reason: string;
}

export interface TemplateScanLimits {
  /** Directory entries (files and directories) visited, not files read. */
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFindings: number;
}

export const DEFAULT_TEMPLATE_SCAN_LIMITS: TemplateScanLimits = {
  maxFiles: 512,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxFindings: 200,
};

export interface TemplateScanOptions {
  readonly limits?: Partial<TemplateScanLimits>;
}

export interface TemplateScanResult {
  /** Files whose text was examined, relative to the scanned directory. */
  readonly scanned: readonly string[];
  /** Entries that were not read, each with the reason. */
  readonly skipped: readonly TemplateScanSkip[];
  readonly findings: readonly TemplateScanFinding[];
  /**
   * True when a limit stopped the walk early. `scanned` is still exact; every
   * entry the walk did not read is named in `skipped` with its reason.
   */
  readonly truncated: boolean;
  readonly limits: TemplateScanLimits;
}

interface ScanRule {
  readonly rule: TemplateScanRule;
  readonly kind: TemplateScanFindingKind;
  readonly pattern: RegExp;
  readonly redact: (match: string, groups: readonly string[]) => string;
}

const SCAN_RULES: readonly ScanRule[] = [
  {
    rule: "private_key",
    kind: "credential",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/u,
    redact: () => "-----BEGIN … PRIVATE KEY-----",
  },
  {
    rule: "aws_access_key",
    kind: "credential",
    pattern: /\bAKIA[0-9A-Z]{16}\b/u,
    redact: (match) => `${match.slice(0, 4)}…`,
  },
  {
    rule: "github_token",
    kind: "credential",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/u,
    redact: (match) => `${match.slice(0, 4)}…`,
  },
  {
    rule: "slack_token",
    kind: "credential",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u,
    redact: (match) => `${match.slice(0, 5)}…`,
  },
  {
    rule: "provider_token",
    kind: "credential",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/u,
    redact: (match) => `${match.slice(0, 3)}…`,
  },
  {
    rule: "secret_assignment",
    kind: "credential",
    // `NAME = value` where the name says it holds a credential, and the value
    // is long enough to be one rather than a placeholder. Case-insensitive:
    // `.env` files conventionally spell these names in lowercase.
    pattern:
      /^\s*(?:export\s+)?([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*\S{8,}/iu,
    redact: (_match, groups) => `${groups[0] ?? "…"}=…`,
  },
  {
    rule: "home_path",
    kind: "pii",
    // The user name may end the path: `HOME=/home/alice` is the leak shape as
    // much as `/home/alice/projects` is. The lookahead stops the match at the
    // end of the name without requiring a component below it. `\/home\/` still
    // excludes `/homepage/alice`.
    pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]+(?![A-Za-z0-9._-])/u,
    redact: (match) => (match.startsWith("/Users/") ? "/Users/…/" : "/home/…/"),
  },
  {
    rule: "email",
    kind: "pii",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u,
    redact: (match) => {
      const at = match.indexOf("@");
      return `${match.slice(0, 1)}…${match.slice(at)}`;
    },
  },
  {
    rule: "phone",
    kind: "pii",
    // International format only: a leading `+` is what separates a phone number
    // from the dates, versions, and numeric constants that fill source code.
    pattern: /\+[1-9]\d{1,3}(?:[ .-]?\d{2,4}){2,4}\b/u,
    redact: (match) => `${match.slice(0, 1)}…`,
  },
];

const linesOf = (text: string): readonly string[] => text.split(/\r?\n/u);

/**
 * One `g`-flagged copy per rule, so every match on a line is reported rather
 * than only the first. `lastIndex` is reset before each line.
 */
const GLOBAL_PATTERNS: readonly { readonly rule: ScanRule; readonly pattern: RegExp }[] =
  SCAN_RULES.map((rule) => ({
    rule,
    pattern: new RegExp(rule.pattern.source, `${rule.pattern.flags}g`),
  }));

const findingsForFile = (
  relative: string,
  text: string,
  limit: number,
): readonly TemplateScanFinding[] => {
  const findings: TemplateScanFinding[] = [];
  const lines = linesOf(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const { rule, pattern } of GLOBAL_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        if (findings.length >= limit) return findings;
        findings.push({
          path: relative,
          line: index + 1,
          rule: rule.rule,
          kind: rule.kind,
          redacted: rule.redact(match[0], match.slice(1)),
        });
        if (match[0].length === 0) pattern.lastIndex += 1;
      }
    }
  }
  return findings;
};

interface ScanState {
  readonly limits: TemplateScanLimits;
  readonly scanned: string[];
  readonly skipped: TemplateScanSkip[];
  readonly findings: TemplateScanFinding[];
  bytes: number;
  entries: number;
  truncated: boolean;
}

const skip = (state: ScanState, relative: string, reason: string): void => {
  state.skipped.push({ path: relative, reason });
};

const scanFile = async (root: string, relative: string, state: ScanState): Promise<void> => {
  const limits = state.limits;
  if (state.findings.length >= limits.maxFindings) {
    state.truncated = true;
    skip(state, relative, `the findings limit of ${limits.maxFindings} was reached`);
    return;
  }
  const target = path.join(root, relative);
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    throw new TemplateStoreError(
      "io_error",
      `could not stat ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (info.size > limits.maxFileBytes) {
    skip(state, relative, `larger than ${limits.maxFileBytes} bytes`);
    return;
  }
  if (state.bytes + info.size > limits.maxTotalBytes) {
    state.truncated = true;
    skip(state, relative, `the scan budget of ${limits.maxTotalBytes} bytes is spent`);
    return;
  }
  let content: Buffer;
  try {
    content = await readFile(target);
  } catch (error) {
    throw new TemplateStoreError(
      "io_error",
      `could not read ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  state.bytes += content.byteLength;
  if (content.includes(0)) {
    skip(state, relative, "binary content (contains a NUL byte)");
    return;
  }
  state.scanned.push(relative);
  const remaining = limits.maxFindings - state.findings.length;
  // Ask for one more than fits: a returned extra is what tells us a finding was
  // dropped, so an exact fit is not reported as truncation.
  const found = findingsForFile(relative, content.toString("utf8"), remaining + 1);
  for (const finding of found.slice(0, remaining)) state.findings.push(finding);
  if (found.length > remaining) state.truncated = true;
};

const walk = async (root: string, relative: string, state: ScanState): Promise<void> => {
  const directory = relative === "" ? root : path.join(root, relative);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new TemplateStoreError(
      "io_error",
      `could not list ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Code-unit order, not `localeCompare`: the scanned/skipped lists and which
  // entries a cap reaches must not depend on the host's collation.
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (state.entries >= state.limits.maxFiles) {
      state.truncated = true;
      skip(state, childRelative, `the entry limit of ${state.limits.maxFiles} was reached`);
      continue;
    }
    state.entries += 1;
    if (entry.name === ".git") {
      // Repository metadata is not package content, and its logs and config
      // are full of addresses and tokens that are not the package's.
      skip(state, childRelative, "version-control metadata (.git) is not scanned");
      continue;
    }
    if (entry.isSymbolicLink()) {
      skip(state, childRelative, "symbolic link (not followed)");
      continue;
    }
    if (entry.isDirectory()) {
      await walk(root, childRelative, state);
      continue;
    }
    if (!entry.isFile()) {
      skip(state, childRelative, "not a regular file");
      continue;
    }
    await scanFile(root, childRelative, state);
  }
};

/**
 * Scan a package directory for credential- and PII-shaped content.
 *
 * The whole directory is walked — the delivered `files/` tree and the
 * top-level manifest, README, and licence — so a secret in a README is reported
 * too. No manifest is required and none is validated: the scan answers "what is
 * in these bytes", which is a question a caller may ask before importing.
 */
export const scanTemplatePackage = async (
  sourceDir: string,
  options: TemplateScanOptions = {},
): Promise<TemplateScanResult> => {
  const root = path.resolve(sourceDir);
  let info;
  try {
    info = await stat(root);
  } catch (error) {
    throw new TemplateStoreError(
      "io_error",
      `could not stat ${root}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!info.isDirectory()) {
    throw new TemplateStoreError("invalid_package", `${root} is not a directory`);
  }
  const state: ScanState = {
    limits: { ...DEFAULT_TEMPLATE_SCAN_LIMITS, ...options.limits },
    scanned: [],
    skipped: [],
    findings: [],
    bytes: 0,
    entries: 0,
    truncated: false,
  };
  await walk(root, "", state);
  return {
    scanned: state.scanned,
    skipped: state.skipped,
    findings: state.findings,
    truncated: state.truncated,
    limits: state.limits,
  };
};
