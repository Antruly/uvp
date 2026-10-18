import type { UvpFeature } from "../domain/features.js";
import {
  parseTemplatePackageVersion,
  type TemplatePackageCategory,
  type TemplatePackageFramework,
  type TemplatePackageManifest,
} from "../domain/templatePackage.js";
import {
  listTemplatePackages,
  type CorruptTemplatePackage,
  type StoredTemplatePackage,
  type TemplateStoreOptions,
} from "./TemplateStore.js";

/**
 * Deterministic search over the local template store (P3 of #236).
 *
 * The caller is usually an external AI, and the answer it needs is a short list
 * of **candidates with the metadata to choose between them**, not a verdict.
 * This module therefore returns every matching package (up to a page) with the
 * fields that distinguish them, plus what matched. It does not rank with a
 * model, and it does not claim "best".
 *
 * Results are metadata only: file digests and a count, never file bytes. `get`
 * (P2) is the call that returns the package's own listing and path.
 *
 * Defaults follow Q9: the latest version of each id, with pinned versions
 * available through `version` or `allVersions`.
 */

export type TemplateTagMode = "all" | "any";

export interface TemplateSearchQuery {
  /** Free text over id, name, description, framework, category, tags, and features. */
  readonly text?: string;
  readonly category?: TemplatePackageCategory;
  readonly framework?: TemplatePackageFramework;
  /** Tags to require; every tag for `all`, any for `any`. */
  readonly tags?: readonly string[];
  readonly tagMode?: TemplateTagMode;
  /** Features the package must require. */
  readonly features?: readonly UvpFeature[];
  /** Return exactly this version, across ids. */
  readonly version?: string;
  /** Return every version; the default is the latest per id. */
  readonly allVersions?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface TemplateSearchMatch {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly category: TemplatePackageCategory;
  readonly framework?: TemplatePackageFramework;
  readonly tags?: readonly string[];
  readonly requires?: TemplatePackageManifest["requires"];
  readonly license?: TemplatePackageManifest["license"];
  readonly provenance?: TemplatePackageManifest["provenance"];
  readonly preview?: string;
  readonly unverified: boolean;
  readonly digest: string;
  readonly file_count: number;
  readonly score: number;
  readonly matched_on: readonly string[];
}

export interface TemplateSearchResult {
  readonly matches: readonly TemplateSearchMatch[];
  /** Matches before pagination. */
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  /** More matches exist after this page. */
  readonly truncated: boolean;
  /** Store entries the reader refused; they are never matches. */
  readonly corrupt: readonly CorruptTemplatePackage[];
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const normalize = (value: string): string => value.trim().toLowerCase();

const normalizedTags = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized !== "") seen.add(normalized);
  }
  return [...seen];
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
      const difference = leftPart.localeCompare(rightPart);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    }
  }
  return 0;
};

/** SemVer order, including prerelease precedence. Exported for the tests. */
export const compareTemplateVersions = (left: string, right: string): number => {
  const a = parseTemplatePackageVersion(left);
  const b = parseTemplatePackageVersion(right);
  if (a === undefined || b === undefined) return left.localeCompare(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === undefined && b.prerelease === undefined) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
};

const latestById = (
  packages: readonly StoredTemplatePackage[],
): readonly StoredTemplatePackage[] => {
  const latest = new Map<string, StoredTemplatePackage>();
  for (const candidate of packages) {
    const current = latest.get(candidate.id);
    if (current === undefined || compareTemplateVersions(candidate.version, current.version) > 0) {
      latest.set(candidate.id, candidate);
    }
  }
  return [...latest.values()];
};

const searchable = (entry: StoredTemplatePackage): string =>
  [
    entry.id,
    entry.name,
    entry.description ?? "",
    entry.framework ?? "",
    entry.category,
    ...(entry.tags ?? []),
    ...(entry.requires?.features ?? []),
  ]
    .join(" ")
    .toLowerCase();

interface Criteria {
  readonly category?: TemplatePackageCategory;
  readonly framework?: TemplatePackageFramework;
  readonly version?: string;
  readonly tags: readonly string[];
  readonly tagMode: TemplateTagMode;
  readonly features: readonly UvpFeature[];
  readonly tokens: readonly string[];
}

const matchesFilters = (entry: StoredTemplatePackage, criteria: Criteria): boolean => {
  if (criteria.category !== undefined && entry.category !== criteria.category) return false;
  if (criteria.framework !== undefined && entry.framework !== criteria.framework) return false;
  if (criteria.version !== undefined && entry.version !== criteria.version) return false;

  if (criteria.tags.length > 0) {
    const tags = new Set((entry.tags ?? []).map(normalize));
    const matched =
      criteria.tagMode === "all"
        ? criteria.tags.every((tag) => tags.has(tag))
        : criteria.tags.some((tag) => tags.has(tag));
    if (!matched) return false;
  }

  if (criteria.features.length > 0) {
    const features = new Set(entry.requires?.features ?? []);
    if (!criteria.features.every((feature) => features.has(feature))) return false;
  }

  if (criteria.tokens.length > 0) {
    const haystack = searchable(entry);
    if (!criteria.tokens.every((token) => haystack.includes(token))) return false;
  }
  return true;
};

const scoreOf = (
  entry: StoredTemplatePackage,
  criteria: Criteria,
): { readonly score: number; readonly matchedOn: readonly string[] } => {
  let score = 0;
  const matchedOn: string[] = [];
  if (criteria.category !== undefined) {
    score += 2;
    matchedOn.push("category");
  }
  if (criteria.framework !== undefined) {
    score += 3;
    matchedOn.push("framework");
  }
  if (criteria.tags.length > 0) {
    const tags = new Set((entry.tags ?? []).map(normalize));
    for (const tag of criteria.tags) {
      if (tags.has(tag)) {
        score += 2;
        matchedOn.push(`tag:${tag}`);
      }
    }
  }
  if (criteria.features.length > 0) {
    const features = new Set(entry.requires?.features ?? []);
    for (const feature of criteria.features) {
      if (features.has(feature)) {
        score += 1;
        matchedOn.push(`feature:${feature}`);
      }
    }
  }
  if (criteria.tokens.length > 0) {
    const haystack = searchable(entry);
    for (const token of criteria.tokens) {
      if (haystack.includes(token)) {
        score += 1;
        matchedOn.push(`text:${token}`);
      }
    }
  }
  return { score, matchedOn };
};

const toMatch = (
  entry: StoredTemplatePackage,
  score: number,
  matchedOn: readonly string[],
): TemplateSearchMatch => ({
  id: entry.id,
  version: entry.version,
  name: entry.name,
  ...(entry.description === undefined ? {} : { description: entry.description }),
  category: entry.category,
  ...(entry.framework === undefined ? {} : { framework: entry.framework }),
  ...(entry.tags === undefined ? {} : { tags: entry.tags }),
  ...(entry.requires === undefined ? {} : { requires: entry.requires }),
  ...(entry.license === undefined ? {} : { license: entry.license }),
  ...(entry.provenance === undefined ? {} : { provenance: entry.provenance }),
  ...(entry.preview === undefined ? {} : { preview: entry.preview }),
  unverified: entry.unverified,
  digest: entry.digest,
  file_count: entry.files.length,
  score,
  matched_on: matchedOn,
});

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
};

/** Search the store; the store's own order is not the caller's ranking. */
export const searchTemplatePackages = async (
  query: TemplateSearchQuery = {},
  options: TemplateStoreOptions = {},
): Promise<TemplateSearchResult> => {
  const criteria: Criteria = {
    ...(query.category === undefined ? {} : { category: query.category }),
    ...(query.framework === undefined ? {} : { framework: query.framework }),
    ...(query.version === undefined ? {} : { version: query.version }),
    tags: normalizedTags(query.tags ?? []),
    tagMode: query.tagMode ?? "all",
    features: [...new Set(query.features ?? [])],
    tokens: normalize(query.text ?? "")
      .split(/\s+/u)
      .filter((token) => token !== ""),
  };
  const limit = boundedInteger(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = boundedInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  const listed = await listTemplatePackages(options);
  const filtered = listed.packages.filter((entry) => matchesFilters(entry, criteria));
  const selected = query.allVersions === true ? filtered : latestById(filtered);
  const scored = selected.map((entry) => {
    const { score, matchedOn } = scoreOf(entry, criteria);
    return { entry, score, matchedOn };
  });
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.entry.id.localeCompare(right.entry.id) ||
      compareTemplateVersions(right.entry.version, left.entry.version),
  );

  const page = scored.slice(offset, offset + limit);
  return {
    matches: page.map(({ entry, score, matchedOn }) => toMatch(entry, score, matchedOn)),
    total: scored.length,
    offset,
    limit,
    truncated: offset + page.length < scored.length,
    corrupt: listed.corrupt,
  };
};
