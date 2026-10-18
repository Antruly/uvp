import {
  compareTemplateVersions,
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
import {
  prepareTemplateCriteria,
  templateMetadataMatches,
  templateMetadataScore,
  type TemplateSearchQuery,
} from "./templateDiscovery.js";

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

export type { TemplateSearchQuery } from "./templateDiscovery.js";

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

export { compareTemplateVersions } from "../domain/templatePackage.js";

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
  const criteria = prepareTemplateCriteria(query);
  const limit = boundedInteger(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = boundedInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  const listed = await listTemplatePackages(options);
  const filtered = listed.packages.filter((entry) => templateMetadataMatches(entry, criteria));
  const selected = query.allVersions === true ? filtered : latestById(filtered);
  const scored = selected.map((entry) => {
    const { score, matchedOn } = templateMetadataScore(entry, criteria);
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
