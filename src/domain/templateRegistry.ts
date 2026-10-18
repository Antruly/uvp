import {
  DEFAULT_TEMPLATE_PACKAGE_LIMITS,
  TEMPLATE_PACKAGE_SCHEMA,
  compareTemplateVersions,
  type TemplatePackageCategory,
  type TemplatePackageFile,
  type TemplatePackageFramework,
  type TemplatePackageLicense,
  type TemplatePackageLimits,
  type TemplatePackageProblem,
  type TemplatePackageProvenance,
  type TemplatePackageRequires,
} from "./templatePackage.js";
import { templatePackageDigestProblem } from "./templatePackageFiles.js";
import { validateTemplatePackage } from "./templatePackageManifest.js";
import { Problems, asString, isRecord } from "./templatePackageProblems.js";

/**
 * The `uvp.registry/1` index — the reader for the shared registry's metadata.
 *
 * The registry repository documents this format in `docs/index-format.md`; the
 * package format itself is owned here, so the index reader does not re-spell
 * the manifest rules. Each version entry is handed to the `uvp.template/1`
 * validator as the manifest it mirrors, and this module adds only the three
 * facts an index entry has that a manifest does not: where the package lives in
 * the registry (`path`), the manifest's canonical digest (`digest`), and that
 * each version entry repeats the manifest's `files[]`.
 *
 * The documented entry shape omits the manifest's `variables` and `preview`,
 * but the registry's generator currently spreads the whole `template.json` into
 * each entry, so those fields (and the redundant `schema`/`id`) can be present.
 * They are accepted and validated with the manifest rules, and `schema`/`id`
 * must agree with the index when present. The generator also repeats its
 * observation list as `files[]`, which carries `binary`; that field is accepted
 * and checked as a boolean, then left out of the manifest-shaped file list.
 *
 * No file bytes are carried: a digest here says what the manifest hashed to; it
 * is verified against downloaded bytes by the client, not inferred from the
 * index.
 *
 * The schema is closed at every level. An entry with an unknown key is a
 * problem rather than something ignored: the registry's own generator is the
 * only producer, and a key this reader dropped could be the one a future client
 * needs.
 */

export const TEMPLATE_REGISTRY_SCHEMA = "uvp.registry/1";

export interface TemplateRegistryVersion {
  readonly version: string;
  /** Repository-relative package directory: `packages/<id>/<version>`. */
  readonly path: string;
  /** `sha256:` over the manifest's canonical JSON, the rule `templatePackageDigest` uses. */
  readonly digest: string;
  readonly name: string;
  readonly description?: string;
  readonly category: TemplatePackageCategory;
  readonly framework?: TemplatePackageFramework;
  readonly tags?: readonly string[];
  readonly requires?: TemplatePackageRequires;
  readonly files: readonly TemplatePackageFile[];
  readonly license: TemplatePackageLicense;
  readonly provenance: TemplatePackageProvenance;
}

export interface TemplateRegistryPackage {
  readonly id: string;
  /**
   * Must name one of `versions`. Trusted as the producer's answer rather than
   * recomputed: the registry's generator takes the highest release (used only
   * when the package has no release), and a client that recomputed it could
   * disagree with the registry's own answer.
   */
  readonly latest: string;
  /** Ascending by SemVer precedence. */
  readonly versions: readonly TemplateRegistryVersion[];
}

export interface TemplateRegistryIndex {
  readonly schema: typeof TEMPLATE_REGISTRY_SCHEMA;
  /** Ascending by id. */
  readonly packages: readonly TemplateRegistryPackage[];
}

export type TemplateRegistryValidation =
  | { readonly ok: true; readonly index: TemplateRegistryIndex }
  | { readonly ok: false; readonly problems: readonly TemplatePackageProblem[] };

const INDEX_KEYS = new Set(["schema", "packages"]);
const PACKAGE_KEYS = new Set(["id", "latest", "versions"]);
const VERSION_KEYS = new Set([
  "version",
  "path",
  "digest",
  "name",
  "description",
  "category",
  "framework",
  "tags",
  "requires",
  "variables",
  "license",
  "provenance",
  "preview",
  "files",
  // The generator spreads `template.json` into the entry, so the manifest's own
  // `schema` and `id` can appear here as redundant repeats.
  "schema",
  "id",
]);

/**
 * Files in an index entry are the generator's observation list: the manifest's
 * `path`/`digest`/`bytes` plus `binary`. Unknown keys are still refused.
 */
const INDEX_FILE_KEYS = new Set(["path", "digest", "bytes", "binary"]);

/** The version-entry fields that are also manifest fields. */
const MANIFEST_FIELDS = [
  "version",
  "name",
  "description",
  "category",
  "framework",
  "tags",
  "requires",
  "variables",
  "license",
  "provenance",
  "preview",
] as const;

const PACKAGE_PATH_PREFIX = "packages/";

/**
 * The registry's id order: ascending by code unit, not by the host locale's
 * collation. The index reader checks it and the search sorts results by it, so
 * both callers use this one comparison.
 */
export const compareTemplateRegistryIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * The manifest file list, with the generator's observation-only `binary`
 * removed. The field is checked here because the manifest rules do not know it;
 * the file's `path`/`digest`/`bytes` are then validated by those same rules.
 */
const indexFiles = (value: unknown, location: string, problems: Problems): unknown => {
  if (!Array.isArray(value)) return value;
  return value.map((entry: unknown, index) => {
    if (!isRecord(entry)) return entry;
    const at = `${location}.files[${index}]`;
    problems.rejectUnknownKeys(entry, `${at}.`, INDEX_FILE_KEYS, TEMPLATE_REGISTRY_SCHEMA);
    if (entry["binary"] !== undefined && typeof entry["binary"] !== "boolean") {
      problems.add(`${at}.binary`, "must be a boolean");
    }
    return { path: entry["path"], digest: entry["digest"], bytes: entry["bytes"] };
  });
};

/**
 * The manifest a version entry mirrors. Unknown keys were already refused at
 * the entry level, so the synthetic record contains manifest fields only and
 * the validator does not report them twice. The generator's redundant `schema`
 * and `id` repeats are checked separately and replaced by the canonical values.
 */
const manifestRecord = (
  entry: Record<string, unknown>,
  location: string,
  packageId: string | undefined,
  problems: Problems,
): Record<string, unknown> => {
  const record: Record<string, unknown> = { schema: TEMPLATE_PACKAGE_SCHEMA };
  if (packageId !== undefined) record["id"] = packageId;
  for (const key of MANIFEST_FIELDS) {
    if (entry[key] !== undefined) record[key] = entry[key];
  }
  if (entry["files"] !== undefined) {
    record["files"] = indexFiles(entry["files"], location, problems);
  }
  return record;
};

function readVersionEntry(
  entry: unknown,
  location: string,
  packageId: string | undefined,
  limits: TemplatePackageLimits,
  problems: Problems,
): TemplateRegistryVersion | undefined {
  if (!isRecord(entry)) {
    problems.add(location, "must be an object");
    return undefined;
  }
  problems.rejectUnknownKeys(entry, `${location}.`, VERSION_KEYS, TEMPLATE_REGISTRY_SCHEMA);

  const before = problems.list.length;
  const version = asString(entry["version"]);
  const sourcePath = asString(entry["path"]);
  const digest = asString(entry["digest"]);

  if (entry["schema"] !== undefined) {
    if (entry["schema"] !== TEMPLATE_PACKAGE_SCHEMA) {
      problems.add(`${location}.schema`, `must be '${TEMPLATE_PACKAGE_SCHEMA}' when present`);
    }
  }
  if (entry["id"] !== undefined) {
    if (packageId === undefined || entry["id"] !== packageId) {
      problems.add(
        `${location}.id`,
        packageId === undefined ? "must be a string" : `must be '${packageId}' when present`,
      );
    }
  }

  if (version === undefined) {
    problems.add(`${location}.version`, "must be a string");
  }
  if (sourcePath === undefined) {
    problems.add(`${location}.path`, "must be a string");
  } else if (packageId !== undefined && version !== undefined) {
    const expected = `${PACKAGE_PATH_PREFIX}${packageId}/${version}`;
    if (sourcePath !== expected) {
      // Exact, not merely "under packages/": the path is fetched as a URL and
      // `<id>/<version>` is the immutable location the registry promises.
      problems.add(`${location}.path`, `must be '${expected}'`);
    }
  }
  if (digest === undefined) {
    problems.add(`${location}.digest`, "must be a string");
  } else {
    const digestProblem = templatePackageDigestProblem(digest);
    if (digestProblem !== undefined) problems.add(`${location}.digest`, digestProblem);
  }

  const validation = validateTemplatePackage({
    manifest: manifestRecord(entry, location, packageId, problems),
    limits,
  });
  if (!validation.ok) {
    for (const problem of validation.problems) {
      problems.add(
        problem.location === "" ? location : `${location}.${problem.location}`,
        problem.message,
      );
    }
    return undefined;
  }
  if (problems.list.length > before || sourcePath === undefined || digest === undefined) {
    return undefined;
  }

  const value = validation.manifest;
  return {
    version: value.version,
    path: sourcePath,
    digest,
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    category: value.category,
    ...(value.framework === undefined ? {} : { framework: value.framework }),
    ...(value.tags === undefined ? {} : { tags: value.tags }),
    ...(value.requires === undefined ? {} : { requires: value.requires }),
    files: value.files,
    license: value.license,
    provenance: value.provenance,
  };
}

function readPackageEntry(
  entry: unknown,
  location: string,
  limits: TemplatePackageLimits,
  problems: Problems,
): TemplateRegistryPackage | undefined {
  if (!isRecord(entry)) {
    problems.add(location, "must be an object");
    return undefined;
  }
  problems.rejectUnknownKeys(entry, `${location}.`, PACKAGE_KEYS, TEMPLATE_REGISTRY_SCHEMA);

  const id = asString(entry["id"]);
  const latest = asString(entry["latest"]);
  if (id === undefined) problems.add(`${location}.id`, "must be a string");
  if (latest === undefined) problems.add(`${location}.latest`, "must be a string");

  const versionsValue = entry["versions"];
  if (!Array.isArray(versionsValue)) {
    problems.add(`${location}.versions`, "must be an array");
    return undefined;
  }
  if (versionsValue.length === 0) {
    problems.add(`${location}.versions`, "must list at least one version");
    return undefined;
  }

  const versions: TemplateRegistryVersion[] = [];
  versionsValue.forEach((value: unknown, index) => {
    const parsed = readVersionEntry(value, `${location}.versions[${index}]`, id, limits, problems);
    if (parsed !== undefined) versions.push(parsed);
  });

  const seenVersions = new Set<string>();
  for (const [index, version] of versions.entries()) {
    if (seenVersions.has(version.version)) {
      problems.add(`${location}.versions[${index}].version`, `duplicates '${version.version}'`);
    }
    seenVersions.add(version.version);
    const previous = versions[index - 1];
    if (previous !== undefined && compareTemplateVersions(previous.version, version.version) >= 0) {
      problems.add(
        `${location}.versions[${index}].version`,
        "must sort after the previous version (ascending SemVer precedence)",
      );
    }
  }

  if (latest !== undefined && !seenVersions.has(latest)) {
    problems.add(`${location}.latest`, `must name one of the package's versions`);
  }

  if (id === undefined || latest === undefined || versions.length !== versionsValue.length) {
    return undefined;
  }
  return { id, latest, versions };
}

export const parseTemplateRegistryIndex = (
  value: unknown,
  limits: TemplatePackageLimits = DEFAULT_TEMPLATE_PACKAGE_LIMITS,
): TemplateRegistryValidation => {
  const problems = new Problems();
  if (!isRecord(value)) {
    problems.add("index", "must be an object");
    return { ok: false, problems: problems.list };
  }
  problems.rejectUnknownKeys(value, "", INDEX_KEYS, TEMPLATE_REGISTRY_SCHEMA);
  if (value["schema"] !== TEMPLATE_REGISTRY_SCHEMA) {
    problems.add("schema", `must be '${TEMPLATE_REGISTRY_SCHEMA}'`);
  }
  const packagesValue = value["packages"];
  if (!Array.isArray(packagesValue)) {
    problems.add("packages", "must be an array");
    return { ok: false, problems: problems.list };
  }

  const packages: TemplateRegistryPackage[] = [];
  packagesValue.forEach((entry: unknown, index) => {
    const parsed = readPackageEntry(entry, `packages[${index}]`, limits, problems);
    if (parsed !== undefined) packages.push(parsed);
  });

  const seenIds = new Set<string>();
  for (const [index, entry] of packages.entries()) {
    if (seenIds.has(entry.id)) {
      problems.add(`packages[${index}].id`, `duplicates '${entry.id}'`);
    }
    seenIds.add(entry.id);
    const previous = packages[index - 1];
    if (previous !== undefined && compareTemplateRegistryIds(previous.id, entry.id) >= 0) {
      problems.add(`packages[${index}].id`, "must sort after the previous id (ascending)");
    }
  }

  if (problems.list.length > 0) return { ok: false, problems: problems.list };
  return {
    ok: true,
    index: {
      schema: TEMPLATE_REGISTRY_SCHEMA,
      packages,
    },
  };
};
