import type { UvpFeature } from "../domain/features.js";
import type {
  TemplatePackageCategory,
  TemplatePackageFramework,
  TemplatePackageRequires,
} from "../domain/templatePackage.js";

/**
 * The question a caller asks when choosing a template, and the metadata that
 * answers it — shared by the local store search and the registry index search.
 *
 * Both searches describe the same packages: the local store holds validated
 * `uvp.template/1` manifests, and the registry index repeats the manifest
 * metadata for packages that have not been downloaded. A filter or a score that
 * differed between them would select different candidates from the same corpus,
 * so the matching rules live here once.
 *
 * Matching is deterministic and metadata-only. Nothing here ranks with a model,
 * claims "best", or reads file bytes; `matched_on` says what matched so a caller
 * can explain the order.
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

/** The fields both a stored manifest and an index entry carry. */
export interface TemplateDiscoveryMetadata {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly category: TemplatePackageCategory;
  readonly framework?: TemplatePackageFramework | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly requires?: TemplatePackageRequires | undefined;
}

export interface TemplateDiscoveryCriteria {
  readonly category?: TemplatePackageCategory;
  readonly framework?: TemplatePackageFramework;
  readonly version?: string;
  readonly tags: readonly string[];
  readonly tagMode: TemplateTagMode;
  readonly features: readonly UvpFeature[];
  readonly tokens: readonly string[];
}

export const normalizeTemplateText = (value: string): string => value.trim().toLowerCase();

const normalizedTags = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeTemplateText(value);
    if (normalized !== "") seen.add(normalized);
  }
  return [...seen];
};

export const prepareTemplateCriteria = (query: TemplateSearchQuery): TemplateDiscoveryCriteria => ({
  ...(query.category === undefined ? {} : { category: query.category }),
  ...(query.framework === undefined ? {} : { framework: query.framework }),
  ...(query.version === undefined ? {} : { version: query.version }),
  tags: normalizedTags(query.tags ?? []),
  tagMode: query.tagMode ?? "all",
  features: [...new Set(query.features ?? [])],
  tokens: normalizeTemplateText(query.text ?? "")
    .split(/\s+/u)
    .filter((token) => token !== ""),
});

const searchable = (entry: TemplateDiscoveryMetadata): string =>
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

export const templateMetadataMatches = (
  entry: TemplateDiscoveryMetadata,
  criteria: TemplateDiscoveryCriteria,
): boolean => {
  if (criteria.category !== undefined && entry.category !== criteria.category) return false;
  if (criteria.framework !== undefined && entry.framework !== criteria.framework) return false;
  if (criteria.version !== undefined && entry.version !== criteria.version) return false;

  if (criteria.tags.length > 0) {
    const tags = new Set((entry.tags ?? []).map(normalizeTemplateText));
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

export const templateMetadataScore = (
  entry: TemplateDiscoveryMetadata,
  criteria: TemplateDiscoveryCriteria,
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
    const tags = new Set((entry.tags ?? []).map(normalizeTemplateText));
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
