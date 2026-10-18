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
 * Two things the index does not carry, and this reader therefore cannot check:
 * the manifest's `variables` and `preview`, and any file bytes. A digest here
 * says what the manifest hashed to; it is verified against downloaded bytes by
 * the client, not inferred from the index.
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
  /** Must name one of `versions`. */
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
  "license",
  "provenance",
  "files",
]);

/** The version-entry fields that are also manifest fields. */
const MANIFEST_FIELDS = [
  "version",
  "name",
  "description",
  "category",
  "framework",
  "tags",
  "requires",
  "files",
  "license",
  "provenance",
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
 * The manifest a version entry mirrors. It omits only `schema`, `variables`,
 * and `preview`, which the index does not carry; unknown keys were already
 * refused at the entry level, so the synthetic record contains manifest fields
 * only and the validator does not report them twice.
 */
const manifestRecord = (
  entry: Record<string, unknown>,
  packageId: string | undefined,
): Record<string, unknown> => {
  const record: Record<string, unknown> = { schema: TEMPLATE_PACKAGE_SCHEMA };
  if (packageId !== undefined) record["id"] = packageId;
  for (const key of MANIFEST_FIELDS) {
    if (entry[key] !== undefined) record[key] = entry[key];
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
    manifest: manifestRecord(entry, packageId),
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
