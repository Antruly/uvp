import { UVP_FEATURES, isUvpFeature } from "./features.js";
import { workspaceNameProblem } from "./workspaceName.js";
import { compareObservations, readFiles } from "./templatePackageFiles.js";
import { Problems, asInteger, asString, isRecord } from "./templatePackageProblems.js";
import {
  DEFAULT_TEMPLATE_PACKAGE_LIMITS,
  TEMPLATE_PACKAGE_CATEGORIES,
  TEMPLATE_PACKAGE_FRAMEWORKS,
  TEMPLATE_PACKAGE_SCHEMA,
  TEMPLATE_PACKAGE_VARIABLES,
  parseTemplatePackageVersion,
  templatePackageDigest,
  templatePackageTextProblem,
  templateVersionRequirementProblem,
  type TemplatePackageCategory,
  type TemplatePackageFileObservation,
  type TemplatePackageFramework,
  type TemplatePackageLicense,
  type TemplatePackageLimits,
  type TemplatePackageManifest,
  type TemplatePackageProvenance,
  type TemplatePackageRequires,
  type TemplatePackageValidation,
  type TemplatePackageValidationInput,
  type TemplatePackageVariable,
  type TemplatePackageVariableName,
} from "./templatePackage.js";

/**
 * The `uvp.template/1` manifest reader.
 *
 * Two decisions shape every check:
 *
 * - **The schema is closed.** An unknown key is a problem, not something to
 *   ignore. A misspelled `licence` that parses anyway would leave the package
 *   claiming a licence it does not carry, and a store that later re-serialises
 *   the manifest would silently drop it.
 * - **The validator reports; it does not throw.** A caller importing a package
 *   needs every problem, not the first one, and the store must be able to write
 *   a report before it writes anything to disk.
 *
 * What this module cannot see, and therefore does not claim: file contents
 * (digests are compared with what the reader observed, never recomputed here),
 * symlinks unless the reader reports them, whether the generated C++ compiles,
 * and whether an SPDX identifier exists. A caller importing a package passes
 * observations from a reader that did list `files/`.
 */

const SPDX_PATTERN = /^[A-Za-z0-9.+-]+$/u;
const CREATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const PREVIEW_PATTERN = /^preview\.(?:png|svg|webp)$/u;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MANIFEST_KEYS = new Set([
  "schema",
  "id",
  "version",
  "name",
  "description",
  "category",
  "framework",
  "tags",
  "requires",
  "variables",
  "files",
  "license",
  "provenance",
  "preview",
  "routes",
]);

const urlProblem = (value: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute http or https URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "must be an absolute http or https URL";
  }
  if (url.username !== "" || url.password !== "") return "must not contain credentials";
  return undefined;
};

function readId(
  record: Record<string, unknown>,
  limits: TemplatePackageLimits,
  problems: Problems,
): string | undefined {
  const id = asString(record["id"]);
  if (id === undefined) {
    problems.add("id", "must be a string");
    return undefined;
  }
  if (id.length > limits.maxIdLength) {
    problems.add("id", `must be at most ${limits.maxIdLength} characters`);
  } else if (!SLUG_PATTERN.test(id)) {
    problems.add("id", "must be a lowercase slug such as 'acme-dashboard'");
  }
  return id;
}

function readVersion(record: Record<string, unknown>, problems: Problems): string | undefined {
  const version = asString(record["version"]);
  if (version === undefined) {
    problems.add("version", "must be a string");
  } else if (parseTemplatePackageVersion(version) === undefined) {
    // A manifest version is not a range: an exact SemVer value only.
    problems.add("version", "must be a SemVer 2.0.0 version such as 1.2.0");
  }
  return version;
}

function readText(
  record: Record<string, unknown>,
  key: "name" | "description",
  max: number,
  problems: Problems,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    if (key === "name") problems.add("name", "is required");
    return undefined;
  }
  if (typeof value !== "string") {
    problems.add(key, "must be a string");
  } else if (value.length === 0) {
    problems.add(key, "must not be empty");
  } else if (value.length > max) {
    problems.add(key, `must be at most ${max} characters`);
  } else {
    const textProblem = templatePackageTextProblem(value);
    if (textProblem !== undefined) problems.add(key, textProblem);
  }
  return typeof value === "string" ? value : undefined;
}

function readCategory(
  record: Record<string, unknown>,
  problems: Problems,
): TemplatePackageCategory | undefined {
  const category = asString(record["category"]);
  if (category === undefined) {
    problems.add("category", "must be a string");
    return undefined;
  }
  if (!(TEMPLATE_PACKAGE_CATEGORIES as readonly string[]).includes(category)) {
    problems.add("category", `must be one of ${TEMPLATE_PACKAGE_CATEGORIES.join(", ")}`);
    return undefined;
  }
  return category as TemplatePackageCategory;
}

function readFramework(
  record: Record<string, unknown>,
  problems: Problems,
): TemplatePackageFramework | undefined {
  const framework = record["framework"];
  if (framework === undefined) return undefined;
  if (typeof framework !== "string") {
    problems.add("framework", "must be a string");
    return undefined;
  }
  if (!(TEMPLATE_PACKAGE_FRAMEWORKS as readonly string[]).includes(framework)) {
    problems.add("framework", `must be one of ${TEMPLATE_PACKAGE_FRAMEWORKS.join(", ")}`);
    return undefined;
  }
  return framework as TemplatePackageFramework;
}

function readTags(
  record: Record<string, unknown>,
  limits: TemplatePackageLimits,
  problems: Problems,
): readonly string[] | undefined {
  const tags = record["tags"];
  if (tags === undefined) return undefined;
  if (!Array.isArray(tags)) {
    problems.add("tags", "must be an array of strings");
    return undefined;
  }
  if (tags.length > limits.maxTags) {
    problems.add("tags", `must contain at most ${limits.maxTags} entries`);
  }
  const seen = new Set<string>();
  tags.forEach((tag: unknown, index) => {
    if (typeof tag !== "string") {
      problems.add(`tags[${index}]`, "must be a string");
    } else if (!SLUG_PATTERN.test(tag) || tag.length > limits.maxTagLength) {
      problems.add(
        `tags[${index}]`,
        `must be a lowercase slug of at most ${limits.maxTagLength} characters`,
      );
    } else if (seen.has(tag)) {
      problems.add(`tags[${index}]`, `duplicates '${tag}'`);
    } else {
      seen.add(tag);
    }
  });
  return tags.filter((tag): tag is string => typeof tag === "string");
}

function readRequires(
  record: Record<string, unknown>,
  problems: Problems,
): TemplatePackageRequires | undefined {
  const requires = record["requires"];
  if (requires === undefined) return undefined;
  if (!isRecord(requires)) {
    problems.add("requires", "must be an object");
    return undefined;
  }
  problems.rejectUnknownKeys(requires, "requires.", new Set(["uvp", "libuvcpp", "features"]));
  for (const key of ["uvp", "libuvcpp"] as const) {
    const value = requires[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      problems.add(`requires.${key}`, "must be a string");
      continue;
    }
    const problem = templateVersionRequirementProblem(value);
    if (problem !== undefined) problems.add(`requires.${key}`, problem);
  }
  const features = requires["features"];
  if (features === undefined) return requires as unknown as TemplatePackageRequires;
  if (!Array.isArray(features)) {
    problems.add("requires.features", "must be an array");
    return requires as unknown as TemplatePackageRequires;
  }
  const seen = new Set<string>();
  features.forEach((feature: unknown, index) => {
    if (typeof feature !== "string") {
      problems.add(`requires.features[${index}]`, "must be a string");
    } else if (!isUvpFeature(feature)) {
      problems.add(`requires.features[${index}]`, `must be one of ${UVP_FEATURES.join(", ")}`);
    } else if (seen.has(feature)) {
      problems.add(`requires.features[${index}]`, `duplicates '${feature}'`);
    } else {
      seen.add(feature);
    }
  });
  return requires as unknown as TemplatePackageRequires;
}

function readVariable(
  name: string,
  descriptor: unknown,
  location: string,
  problems: Problems,
): TemplatePackageVariable | undefined {
  if (name !== "name" && name !== "port") {
    problems.add(
      location,
      `is not one of the placeholders ${TEMPLATE_PACKAGE_VARIABLES.join(", ")}`,
    );
    return undefined;
  }
  if (!isRecord(descriptor)) {
    problems.add(location, "must be an object");
    return undefined;
  }
  problems.rejectUnknownKeys(descriptor, `${location}.`, new Set(["type", "required", "default"]));
  const expected = name === "name" ? "slug" : "port";
  if (descriptor["type"] !== expected) problems.add(`${location}.type`, `must be '${expected}'`);
  const required = descriptor["required"];
  if (required !== undefined && typeof required !== "boolean") {
    problems.add(`${location}.required`, "must be a boolean");
  }
  const fallback = descriptor["default"];
  if (fallback !== undefined) {
    if (name === "name") {
      if (typeof fallback !== "string") problems.add(`${location}.default`, "must be a string");
      else {
        const problem = workspaceNameProblem(fallback);
        if (problem !== undefined) problems.add(`${location}.default`, problem);
      }
    } else {
      const port = asInteger(fallback);
      if (port === undefined || port < 1 || port > 65_535) {
        problems.add(`${location}.default`, "must be an integer from 1 to 65535");
      }
    }
  }
  return descriptor as unknown as TemplatePackageVariable;
}

function readVariables(
  record: Record<string, unknown>,
  problems: Problems,
): Readonly<Partial<Record<TemplatePackageVariableName, TemplatePackageVariable>>> | undefined {
  const variables = record["variables"];
  if (variables === undefined) return undefined;
  if (!isRecord(variables)) {
    problems.add("variables", "must be an object");
    return undefined;
  }
  for (const [name, descriptor] of Object.entries(variables)) {
    readVariable(name, descriptor, `variables.${name}`, problems);
  }
  return variables as unknown as Readonly<
    Partial<Record<TemplatePackageVariableName, TemplatePackageVariable>>
  >;
}

function readLicense(
  record: Record<string, unknown>,
  limits: TemplatePackageLimits,
  problems: Problems,
): TemplatePackageLicense | undefined {
  const license = record["license"];
  if (license === undefined) {
    problems.add("license", "is required");
    return undefined;
  }
  if (!isRecord(license)) {
    problems.add("license", "must be an object");
    return undefined;
  }
  problems.rejectUnknownKeys(license, "license.", new Set(["spdx", "name", "file"]));
  const spdx = license["spdx"];
  if (spdx !== undefined) {
    if (typeof spdx !== "string") problems.add("license.spdx", "must be a string");
    else if (!SPDX_PATTERN.test(spdx) || spdx.length > limits.maxSpdxLength) {
      problems.add(
        "license.spdx",
        `must be a single SPDX identifier such as MIT or Apache-2.0 (at most ${limits.maxSpdxLength} characters)`,
      );
    }
  }
  const name = license["name"];
  if (name !== undefined) {
    if (typeof name !== "string") problems.add("license.name", "must be a string");
    else if (name.length === 0 || name.length > limits.maxLicenseNameLength) {
      problems.add("license.name", `must be 1 to ${limits.maxLicenseNameLength} characters`);
    } else {
      const textProblem = templatePackageTextProblem(name);
      if (textProblem !== undefined) problems.add("license.name", textProblem);
    }
  }
  if (spdx === undefined && name === undefined) {
    problems.add("license", "must declare spdx or name");
  }
  if (license["file"] !== "LICENSE") {
    problems.add("license.file", "must be 'LICENSE', the package-root licence file");
  }
  return license as unknown as TemplatePackageLicense;
}

const isCalendarTimestamp = (value: string): boolean => {
  if (!CREATED_AT_PATTERN.test(value)) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  // `Date.parse` rolls a nonexistent day such as 31 February into March; a
  // provenance time that names a day the calendar does not have is a data
  // error, not a time to normalise silently.
  return date.toISOString().slice(0, 10) === value.slice(0, 10);
};

function readProvenance(
  record: Record<string, unknown>,
  limits: TemplatePackageLimits,
  problems: Problems,
): TemplatePackageProvenance | undefined {
  const provenance = record["provenance"];
  if (provenance === undefined) {
    problems.add("provenance", "is required");
    return undefined;
  }
  if (!isRecord(provenance)) {
    problems.add("provenance", "must be an object");
    return undefined;
  }
  problems.rejectUnknownKeys(
    provenance,
    "provenance.",
    new Set(["author", "source", "revision", "createdAt"]),
  );
  const author = provenance["author"];
  if (typeof author !== "string" || author.length === 0 || author.length > limits.maxAuthorLength) {
    problems.add(
      "provenance.author",
      `must be a non-empty string of at most ${limits.maxAuthorLength} characters`,
    );
  } else {
    const textProblem = templatePackageTextProblem(author);
    if (textProblem !== undefined) problems.add("provenance.author", textProblem);
  }
  const createdAt = provenance["createdAt"];
  if (typeof createdAt !== "string" || !isCalendarTimestamp(createdAt)) {
    problems.add(
      "provenance.createdAt",
      "must be a UTC ISO-8601 timestamp such as 2026-10-18T00:00:00Z",
    );
  }
  const source = provenance["source"];
  if (source !== undefined) {
    if (typeof source !== "string") {
      problems.add("provenance.source", "must be a string");
    } else {
      const problem = urlProblem(source);
      if (problem !== undefined) problems.add("provenance.source", problem);
    }
  }
  const revision = provenance["revision"];
  if (
    revision !== undefined &&
    (typeof revision !== "string" ||
      revision.length === 0 ||
      revision.length > limits.maxRevisionLength)
  ) {
    problems.add(
      "provenance.revision",
      `must be a non-empty string of at most ${limits.maxRevisionLength} characters`,
    );
  } else if (typeof revision === "string") {
    const textProblem = templatePackageTextProblem(revision);
    if (textProblem !== undefined) problems.add("provenance.revision", textProblem);
  }
  return provenance as unknown as TemplatePackageProvenance;
}

function readPreview(record: Record<string, unknown>, problems: Problems): string | undefined {
  const preview = record["preview"];
  if (preview === undefined) return undefined;
  if (typeof preview !== "string" || !PREVIEW_PATTERN.test(preview)) {
    problems.add("preview", "must be 'preview.png', 'preview.svg', or 'preview.webp'");
    return undefined;
  }
  return preview;
}

/** `METHOD /path`, the same spelling `uvp_workspace_create` reports. */
const ROUTE_PATTERN = /^[A-Z][A-Z0-9-]* \/\S*$/u;

function readRoutes(
  record: Record<string, unknown>,
  limits: TemplatePackageLimits,
  problems: Problems,
): readonly string[] | undefined {
  const routes = record["routes"];
  if (routes === undefined) return undefined;
  if (!Array.isArray(routes)) {
    problems.add("routes", "must be an array");
    return undefined;
  }
  if (routes.length > limits.maxRoutes) {
    problems.add("routes", `contains more than ${limits.maxRoutes} routes`);
  }
  const seen = new Set<string>();
  for (const [index, route] of routes.entries()) {
    if (typeof route !== "string" || !ROUTE_PATTERN.test(route)) {
      problems.add(
        `routes[${index}]`,
        "must be 'METHOD /path' with an uppercase method and no whitespace in the path",
      );
      continue;
    }
    if (route.length > limits.maxRouteLength) {
      problems.add(`routes[${index}]`, `is longer than ${limits.maxRouteLength} characters`);
    }
    if (seen.has(route)) problems.add(`routes[${index}]`, `duplicates '${route}'`);
    seen.add(route);
  }
  return routes as readonly string[];
}

function validateManifest(
  value: unknown,
  observations: readonly TemplatePackageFileObservation[] | undefined,
  limits: TemplatePackageLimits,
  problems: Problems,
): TemplatePackageManifest | undefined {
  if (!isRecord(value)) {
    problems.add("manifest", "must be an object");
    return undefined;
  }
  problems.rejectUnknownKeys(value, "", MANIFEST_KEYS);
  if (value["schema"] !== TEMPLATE_PACKAGE_SCHEMA) {
    problems.add("schema", `must be '${TEMPLATE_PACKAGE_SCHEMA}'`);
  }
  const id = readId(value, limits, problems);
  const version = readVersion(value, problems);
  const name = readText(value, "name", limits.maxNameLength, problems);
  const description = readText(value, "description", limits.maxDescriptionLength, problems);
  const category = readCategory(value, problems);
  const framework = readFramework(value, problems);
  const tags = readTags(value, limits, problems);
  const requires = readRequires(value, problems);
  const variables = readVariables(value, problems);
  const files = readFiles(value, limits, problems);
  const license = readLicense(value, limits, problems);
  const provenance = readProvenance(value, limits, problems);
  const preview = readPreview(value, problems);
  const routes = readRoutes(value, limits, problems);
  if (files !== undefined && observations !== undefined) {
    compareObservations(files, observations, limits, problems);
  }
  if (problems.list.length > 0) return undefined;
  if (
    id === undefined ||
    version === undefined ||
    name === undefined ||
    category === undefined ||
    files === undefined ||
    license === undefined ||
    provenance === undefined
  ) {
    return undefined;
  }
  return {
    schema: TEMPLATE_PACKAGE_SCHEMA,
    id,
    version,
    name,
    ...(description === undefined ? {} : { description }),
    category,
    ...(framework === undefined ? {} : { framework }),
    ...(tags === undefined ? {} : { tags }),
    ...(requires === undefined ? {} : { requires }),
    ...(variables === undefined ? {} : { variables }),
    files,
    license,
    provenance,
    ...(preview === undefined ? {} : { preview }),
    ...(routes === undefined ? {} : { routes }),
  };
}

export const validateTemplatePackage = (
  input: TemplatePackageValidationInput,
): TemplatePackageValidation => {
  const problems = new Problems();
  const limits = input.limits ?? DEFAULT_TEMPLATE_PACKAGE_LIMITS;
  const manifest = validateManifest(input.manifest, input.files, limits, problems);
  return problems.list.length === 0 && manifest !== undefined
    ? {
        ok: true,
        manifest,
        digest: templatePackageDigest(manifest),
        filesObserved: input.files !== undefined,
        problems: [],
      }
    : { ok: false, problems: problems.list };
};
