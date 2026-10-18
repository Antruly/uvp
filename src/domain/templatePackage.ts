import type { UvpFeature } from "./features.js";
import { canonicalJson, sha256 } from "./identity.js";

/**
 * The `uvp.template/1` package format — vocabulary and leaf rules.
 *
 * A template package is data, not code: a manifest, a source tree under
 * `files/`, a README, a licence, and an optional preview. This module is the
 * single owner of that format's vocabulary (categories, frameworks, limits,
 * variable names) and of the rules that read one value at a time. The manifest
 * reader and the `validateTemplatePackage` entry point are in
 * `templatePackageManifest.ts`; they use these predicates rather than
 * re-spelling a path or version rule of their own.
 */

export const TEMPLATE_PACKAGE_SCHEMA = "uvp.template/1";

/**
 * The package categories.
 *
 * Closed on purpose: search and `uvp init` both branch on this value, and a new
 * category that only one of them knows would be a filter that selects nothing
 * or a package that cannot be selected. `module` is the composition unit from
 * `modules.ts`; it is listed here so the package format does not need a second
 * revision when the module increment lands.
 */
export const TEMPLATE_PACKAGE_CATEGORIES = ["frontend", "backend", "fullstack", "module"] as const;

export type TemplatePackageCategory = (typeof TEMPLATE_PACKAGE_CATEGORIES)[number];

/**
 * The framework vocabulary.
 *
 * These are the base choices recorded in the parent design. A package may omit
 * `framework`; when it is present this list is the authority, so a typo such as
 * `vue` is refused rather than stored as a framework no search will match.
 * Adding a framework is a diff in this file and in the published docs.
 */
export const TEMPLATE_PACKAGE_FRAMEWORKS = [
  "h5",
  "vue3",
  "react",
  "svelte",
  "alpine",
  "htmx",
] as const;

export type TemplatePackageFramework = (typeof TEMPLATE_PACKAGE_FRAMEWORKS)[number];

/**
 * The placeholder names a v1 package may declare a variable for.
 *
 * They are the placeholders the design fixed: `{{project.name}}`,
 * `{{project.port}}`, and `{{features}}`. `features` is not a variable — it is
 * substituted from `requires.features` — so only `name` and `port` appear here.
 * A package that invented `{{project.title}}` would render the placeholder
 * literally into a compiled file; refusing the variable at validation time is
 * what keeps that from becoming a build failure later.
 */
export const TEMPLATE_PACKAGE_VARIABLES = ["name", "port"] as const;

export type TemplatePackageVariableName = (typeof TEMPLATE_PACKAGE_VARIABLES)[number];

/**
 * The limits P1 enforces.
 *
 * Q8 in the design comment is still open for P2/P4, so these numbers are named
 * and documented rather than buried: they are the validator's contract today,
 * and changing them does not change the manifest schema. They are deliberately
 * small enough that a listing cannot exhaust a host before the store's own
 * checks run. `maxFileBytes` bounds one file; `maxTotalBytes` the declared sum.
 */
export interface TemplatePackageLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPathLength: number;
  readonly maxNameLength: number;
  readonly maxDescriptionLength: number;
  readonly maxTags: number;
  readonly maxTagLength: number;
  readonly maxIdLength: number;
  readonly maxAuthorLength: number;
  readonly maxRevisionLength: number;
  readonly maxLicenseNameLength: number;
  readonly maxSpdxLength: number;
  readonly maxRoutes: number;
  readonly maxRouteLength: number;
}

export const DEFAULT_TEMPLATE_PACKAGE_LIMITS: TemplatePackageLimits = {
  maxFiles: 512,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxPathLength: 240,
  maxNameLength: 80,
  maxDescriptionLength: 2000,
  maxTags: 20,
  maxTagLength: 32,
  maxIdLength: 64,
  maxAuthorLength: 120,
  maxRevisionLength: 120,
  maxLicenseNameLength: 80,
  maxSpdxLength: 64,
  maxRoutes: 64,
  maxRouteLength: 200,
};

export interface TemplatePackageVariable {
  readonly type: "slug" | "port";
  readonly required?: boolean;
  readonly default?: string | number;
}

export interface TemplatePackageRequires {
  readonly uvp?: string;
  readonly libuvcpp?: string;
  readonly features?: readonly UvpFeature[];
}

export interface TemplatePackageLicense {
  /**
   * A single SPDX identifier such as `MIT` or `Apache-2.0`, with an optional
   * trailing `+`. Expressions (`MIT OR Apache-2.0`) are not accepted; the
   * existence of the identifier is not checked here.
   */
  readonly spdx?: string;
  /** A free-text licence name, for a licence that has no SPDX identifier. */
  readonly name?: string;
  /** The licence file at the package root. */
  readonly file: "LICENSE";
}

export interface TemplatePackageProvenance {
  readonly author: string;
  readonly source?: string;
  readonly revision?: string;
  /** UTC ISO-8601. Provenance without a time cannot be ordered. */
  readonly createdAt: string;
}

export interface TemplatePackageFile {
  readonly path: string;
  /** `sha256:<64 lowercase hex>` over the file's raw bytes. */
  readonly digest: string;
  readonly bytes: number;
}

export interface TemplatePackageManifest {
  readonly schema: typeof TEMPLATE_PACKAGE_SCHEMA;
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly category: TemplatePackageCategory;
  readonly framework?: TemplatePackageFramework;
  readonly tags?: readonly string[];
  readonly requires?: TemplatePackageRequires;
  readonly variables?: Readonly<
    Partial<Record<TemplatePackageVariableName, TemplatePackageVariable>>
  >;
  readonly files: readonly TemplatePackageFile[];
  readonly license: TemplatePackageLicense;
  readonly provenance: TemplatePackageProvenance;
  /** A root-level `preview.png`, `preview.svg`, or `preview.webp`. */
  readonly preview?: string;
  /**
   * The routes the generated service registers, as `METHOD /path`.
   *
   * Declared by the package rather than derived from its source: deriving them
   * would be a second interpretation of code uvp does not execute. Absent means
   * the package declares none, and `uvp init` reports `routes: []` with a
   * limitation rather than guessing.
   */
  readonly routes?: readonly string[];
}

/**
 * What a reader observed under `files/`.
 *
 * The validator never opens a file. `symlink` and `binary` are the reader's
 * observations; leaving them out means "not examined", and the validator does
 * not invent either answer. `digest` is optional for the same reason: a reader
 * that hashed the bytes can supply it, a reader that only listed the directory
 * cannot.
 */
export interface TemplatePackageFileObservation {
  readonly path: string;
  readonly bytes: number;
  readonly symlink?: boolean;
  readonly binary?: boolean;
  readonly digest?: string;
}

export interface TemplatePackageProblem {
  /** Where the problem is: a manifest field, or `files[i].path`. */
  readonly location: string;
  readonly message: string;
}

export type TemplatePackageValidation =
  | {
      readonly ok: true;
      readonly manifest: TemplatePackageManifest;
      /** `sha256:<hex>` over the RFC 8785 canonical manifest. */
      readonly digest: string;
      /**
       * Whether the caller supplied a listing of `files/`.
       *
       * `false` means the validator examined the declaration only: the
       * manifest is well-formed, but nothing says the tree matches it.
       */
      readonly filesObserved: boolean;
      readonly problems: readonly [];
    }
  | { readonly ok: false; readonly problems: readonly TemplatePackageProblem[] };

export interface TemplatePackageValidationInput {
  readonly manifest: unknown;
  /** The reader's listing of `files/`, when the caller has one. */
  readonly files?: readonly TemplatePackageFileObservation[];
  readonly limits?: TemplatePackageLimits;
}

/**
 * The official SemVer 2.0.0 grammar.
 *
 * A version is an identity claim — `id@version` is immutable — so `1.0`,
 * `v1.0.0`, and `01.0.0` are refused rather than normalised into a string the
 * store would then have to compare by a rule of its own.
 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export interface TemplatePackageVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
  readonly build?: string;
}

export const parseTemplatePackageVersion = (value: string): TemplatePackageVersion | undefined => {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease, build] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    ...(prerelease === undefined ? {} : { prerelease }),
    ...(build === undefined ? {} : { build }),
  };
};

const comparePrerelease = (left: string, right: string): number => {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftPart) - Number(rightPart);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    } else if (leftNumeric) {
      return -1;
    } else if (rightNumeric) {
      return 1;
    } else {
      // SemVer orders non-numeric identifiers by ASCII code unit, not by a
      // locale's collation: the comparison must not depend on the host locale.
      if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
};

/**
 * SemVer precedence, including prerelease ordering. Build metadata is ignored.
 *
 * It lives here rather than in the search module because the registry index
 * reader also decides whether a `versions` list is ascending; both callers ask
 * the same question of the same vocabulary.
 */
export const compareTemplateVersions = (left: string, right: string): number => {
  const a = parseTemplatePackageVersion(left);
  const b = parseTemplatePackageVersion(right);
  // Callers pass validated versions; the fallback still orders deterministically
  // by code unit rather than by the host locale's collation.
  if (a === undefined || b === undefined) return left === right ? 0 : left < right ? -1 : 1;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === undefined && b.prerelease === undefined) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
};

/**
 * Why a requirement range is not one this revision understands.
 *
 * The accepted subset is a whitespace-separated comparator set (`>=0.3.0`,
 * `>=1.7.0 <2.0.0`) or an exact version. Ranges are not evaluated here — P1
 * only fixes the spelling, so a manifest cannot carry a range whose meaning
 * differs between the store and `uvp init`.
 */
export const templateVersionRequirementProblem = (value: string): string | undefined => {
  if (value.trim() !== value || value.length === 0) {
    return "use a non-empty version requirement without surrounding whitespace";
  }
  for (const comparator of value.split(/\s+/u)) {
    const match = /^(?:>=|<=|>|<|=)?(.*)$/u.exec(comparator);
    if (match === null || parseTemplatePackageVersion(match[1] ?? "") === undefined) {
      return `'${comparator}' is not a comparator over a full version such as >=1.7.0`;
    }
  }
  return undefined;
};

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * Why `value` cannot be a single-line display field (a package name,
 * description, or author), or undefined.
 *
 * These strings are shown in search results and reports. A control character
 * can rewrite the line a terminal has already written, so a package could make
 * a result look like a different one; refusing them keeps the display honest
 * rather than relying on every consumer to sanitise it. Newlines are refused
 * too: these fields are one line, and a description is not a document.
 */
export const templatePackageTextProblem = (value: string): string | undefined =>
  hasControlCharacter(value) ? "contains a control character" : undefined;

/**
 * Why `path` cannot be a package-relative file path, or undefined.
 *
 * Paths are interpreted on every host the package may be extracted or built on,
 * so Windows rules apply on Linux too: a tree that imports cleanly on one host
 * and cannot be written on another would make the store's contents depend on
 * where the import ran.
 */
export const templatePackagePathProblem = (
  path: string,
  limits: TemplatePackageLimits = DEFAULT_TEMPLATE_PACKAGE_LIMITS,
): string | undefined => {
  if (path.length === 0) return "is empty";
  if (path.length > limits.maxPathLength) {
    return `is longer than ${limits.maxPathLength} characters`;
  }
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.startsWith("~")) {
    return "must be relative to the package's files/ directory";
  }
  if (path === "files" || path.startsWith("files/")) {
    return "must not name the files/ directory, which these paths are already relative to";
  }
  if (path.includes("\\")) return "must use '/' as the separator, not '\\'";
  const textProblem = templatePackageTextProblem(path);
  if (textProblem !== undefined) return textProblem;
  if (/[<>:"|?*]/u.test(path)) return "contains a character that is not portable to Windows";
  for (const segment of path.split("/")) {
    if (segment.length === 0) return "contains an empty path segment";
    if (segment === "." || segment === "..") return "contains a traversal segment";
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      return "has a segment ending in a dot or space, which Windows strips";
    }
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)) {
      return `uses the reserved device name '${segment}'`;
    }
  }
  return undefined;
};

/** The package's canonical digest: RFC 8785 over the manifest, then sha256. */
export const templatePackageDigest = (manifest: TemplatePackageManifest): string =>
  `sha256:${sha256(canonicalJson(manifest))}`;
