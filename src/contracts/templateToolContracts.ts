import { z } from "zod";

import { UVP_FEATURES } from "../domain/features.js";
import {
  TEMPLATE_PACKAGE_CATEGORIES,
  TEMPLATE_PACKAGE_FRAMEWORKS,
  parseTemplatePackageVersion,
} from "../domain/templatePackage.js";
import { defineTool } from "./toolContractTypes.js";
import { toolEnvelopeShape } from "./toolOutputSchemaPrimitives.js";

/**
 * The template-store tools (P5 of #236).
 *
 * These are the AI-facing surface over the local package store and the package
 * format. They read the same application functions the store, search, inspect,
 * export, and scan increments built; none of them re-interprets a manifest.
 *
 * Effects follow Q13: `search`, `get`, and `validate` only read; `import`,
 * `export`, and `remove` write and can change state outside the uvp workspace,
 * so all three declare `mutatesTarget: true`. None declares a network request,
 * a process spawn, or a credential.
 *
 * The store root is not an input. It is resolved by the store from
 * `UVP_TEMPLATE_HOME` or `~/.uvp/templates`, so two callers of the same tool
 * cannot silently use different stores.
 */

const templateId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "must be a lowercase slug")
  .max(64)
  .describe("Package id, a lowercase slug such as `acme-dashboard`.");

const templateVersion = z
  .string()
  .refine(
    (value) => parseTemplatePackageVersion(value) !== undefined,
    "must be SemVer 2.0.0 without a range",
  )
  .describe("An exact package version; ranges are not accepted.");

const packageFile = z.object({
  path: z.string().describe("Path relative to the package's `files/` directory."),
  bytes: z.number().int().nonnegative(),
  digest: z.string().describe("`sha256:` and 64 lowercase hex characters."),
});

const packageLicense = z.object({
  spdx: z.string().optional(),
  name: z.string().optional(),
  file: z.string(),
});

const packageProvenance = z.object({
  author: z.string(),
  source: z.string().optional(),
  revision: z.string().optional(),
  createdAt: z.string(),
});

const packageRequires = z.object({
  uvp: z.string().optional(),
  libuvcpp: z.string().optional(),
  features: z.array(z.enum(UVP_FEATURES)).optional(),
});

const packageFields = {
  id: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string().optional(),
  category: z.enum(TEMPLATE_PACKAGE_CATEGORIES),
  framework: z.enum(TEMPLATE_PACKAGE_FRAMEWORKS).optional(),
  tags: z.array(z.string()).optional(),
  requires: packageRequires.optional(),
  license: packageLicense.optional(),
  provenance: packageProvenance.optional(),
  digest: z.string().describe("The package digest over the manifest's canonical JSON."),
  files: z.array(packageFile),
  preview: z.string().optional(),
  routes: z
    .array(z.string())
    .optional()
    .describe("The routes the package declares, as `METHOD /path`."),
  unverified: z
    .boolean()
    .describe("True only when the package was admitted without licence or provenance."),
} as const;

const scanSummary = z.object({
  findings: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().positive(),
      rule: z.string(),
      kind: z.enum(["credential", "pii"]),
      redacted: z.string(),
    }),
  ),
  scanned: z.array(z.string()),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  truncated: z.boolean(),
  limits: z.object({
    maxFiles: z.number().int(),
    maxFileBytes: z.number().int(),
    maxTotalBytes: z.number().int(),
    maxFindings: z.number().int(),
  }),
});

/**
 * Ask the local store for candidate templates.
 *
 * The result is a proposal list, not a verdict: it says which packages matched
 * and why, and leaves the choice to the caller. A search never reads file bytes
 * and never contacts the registry; `get` is the call that returns a package's
 * file list and `import` is the call that writes one.
 */
export const templateSearchContract = defineTool({
  name: "uvp_template_search",
  title: "Search the local template store",
  description:
    "Search the locally installed `uvp.template/1` packages by category, framework, tags, " +
    "required libuvcpp features, exact version, or free text. Returns every matching package " +
    "up to a page with the metadata needed to choose between them, what matched, and a " +
    "deterministic score. By default only the latest version of each id is returned. " +
    "Metadata only: no file bytes, no network, and no model call.",
  kind: "workspace",
  inputSchema: z.object({
    text: z
      .string()
      .optional()
      .describe("Free text over id, name, description, framework, category, tags, and features."),
    category: z.enum(TEMPLATE_PACKAGE_CATEGORIES).optional(),
    framework: z.enum(TEMPLATE_PACKAGE_FRAMEWORKS).optional(),
    tags: z.array(z.string()).optional(),
    tag_mode: z
      .enum(["all", "any"])
      .default("all")
      .describe("Every tag must match for `all`; at least one for `any`."),
    features: z
      .array(z.enum(UVP_FEATURES))
      .optional()
      .describe("Features the package must require in its manifest."),
    version: templateVersion.optional().describe("Return exactly this version, across ids."),
    all_versions: z
      .boolean()
      .default(false)
      .describe("Return every version; the default is the latest per id."),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    matches: z.array(
      z.object({
        id: z.string(),
        version: z.string(),
        name: z.string(),
        description: z.string().optional(),
        category: z.enum(TEMPLATE_PACKAGE_CATEGORIES),
        framework: z.enum(TEMPLATE_PACKAGE_FRAMEWORKS).optional(),
        tags: z.array(z.string()).optional(),
        requires: packageRequires.optional(),
        license: packageLicense.optional(),
        provenance: packageProvenance.optional(),
        preview: z.string().optional(),
        unverified: z.boolean(),
        digest: z.string(),
        file_count: z.number().int().nonnegative(),
        score: z.number(),
        matched_on: z.array(z.string()),
      }),
    ),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    truncated: z.boolean(),
    corrupt: z.array(z.object({ path: z.string(), problems: z.array(z.string()) })),
  }),
  effects: {
    readsFilesystem: true,
    writesFilesystem: false,
    network: false,
    spawnsProcess: false,
    mutatesTarget: false,
  },
  examples: [
    {
      description: "Find a WebSocket-capable frontend package",
      input: { category: "fullstack", features: ["websocket"], limit: 10 },
    },
    {
      description: "Find packages tagged dashboard or admin",
      input: { tags: ["dashboard", "admin"], tag_mode: "any" },
    },
  ],
});

/** Read one stored package's manifest and file list, re-verifying its bytes. */
export const templateGetContract = defineTool({
  name: "uvp_template_get",
  title: "Read a stored template package",
  description:
    "Read one exact `id@version` from the local template store. Re-verifies every file against " +
    "the manifest, then returns the manifest fields, the file list with digests and byte counts, " +
    "the store path, and whether the package was admitted as unverified. A missing package and " +
    "a corrupt package are different failures.",
  kind: "workspace",
  inputSchema: z.object({
    id: templateId,
    version: templateVersion,
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    ...packageFields,
    path: z.string().describe("The directory the store holds this package in."),
  }),
  effects: {
    readsFilesystem: true,
    writesFilesystem: false,
    network: false,
    spawnsProcess: false,
    mutatesTarget: false,
  },
  examples: [
    { description: "Read acme-dashboard 1.2.0", input: { id: "acme-dashboard", version: "1.2.0" } },
  ],
});

/**
 * Validate a package directory without importing it.
 *
 * This is the import's format verdict without the write. It does not consult the
 * store, so a package that is already installed passes here and the import then
 * refuses it with `template_exists`.
 */
export const templateValidateContract = defineTool({
  name: "uvp_template_validate",
  title: "Validate a template package directory",
  description:
    "Validate a package directory against `uvp.template/1` exactly as an import would, without " +
    "writing anything. Returns the manifest, the observed file list, and the package digest. " +
    "A package whose only problems are licence/provenance is admitted only when " +
    "allow_unverified is set. It does not check whether the package is already installed.",
  kind: "workspace",
  inputSchema: z.object({
    source_dir: z.string().min(1).describe("Absolute path to the package directory."),
    allow_unverified: z
      .boolean()
      .default(false)
      .describe("Admit a package whose only problems are licence/provenance, marked unverified."),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    ...packageFields,
    source_dir: z.string(),
  }),
  effects: {
    readsFilesystem: true,
    writesFilesystem: false,
    network: false,
    spawnsProcess: false,
    mutatesTarget: false,
  },
  examples: [
    {
      description: "Validate a package before importing it",
      input: { source_dir: "/home/dev/acme-dashboard" },
    },
  ],
});

/**
 * Import a package, or report what an import would do.
 *
 * The scan is part of the result rather than a separate tool call: a caller that
 * is about to install a package should see the credential/PII findings in the
 * same answer, with the scan's own coverage. Findings are reported, not silently
 * treated as clean; the import itself is the store's decision.
 */
export const templateImportContract = defineTool({
  name: "uvp_template_import",
  title: "Import a template package",
  description:
    "Validate, scan, and import a package directory into the local store. `dry_run` returns " +
    "the validation and scan without writing. An existing id@version is refused unless " +
    "`replace` is explicit. `allow_unverified` admits a package whose only problems are " +
    "licence/provenance, marks it unverified, and is never the default. The scan is a bounded " +
    "locator for credential- and PII-shaped content, not a guarantee that the package is clean.",
  kind: "workspace",
  inputSchema: z.object({
    source_dir: z.string().min(1).describe("Absolute path to the package directory."),
    replace: z
      .boolean()
      .default(false)
      .describe("Replace an existing id@version explicitly; never implicit."),
    allow_unverified: z
      .boolean()
      .default(false)
      .describe("Admit a package whose only problems are licence/provenance."),
    dry_run: z.boolean().default(false).describe("Validate and scan without writing to the store."),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    ...packageFields,
    path: z.string().optional().describe("Present when the package was written to the store."),
    replaced: z.boolean(),
    dry_run: z.boolean(),
    retained: z.string().optional().describe("A trash directory whose cleanup failed."),
    scan: scanSummary,
  }),
  effects: {
    readsFilesystem: true,
    writesFilesystem: true,
    network: false,
    spawnsProcess: false,
    mutatesTarget: true,
  },
  examples: [
    {
      description: "Check a package without installing it",
      input: { source_dir: "/home/dev/acme-dashboard", dry_run: true },
    },
    {
      description: "Install or replace a package after validating it",
      input: { source_dir: "/home/dev/acme-dashboard", replace: true },
    },
  ],
});

/** Copy a stored package to a directory the caller names. */
export const templateExportContract = defineTool({
  name: "uvp_template_export",
  title: "Export a stored template package",
  description:
    "Copy one stored id@version to a directory. The target must be absent or empty; a non-empty " +
    "target is refused. The copy is staged and every exported file is re-verified against the " +
    "manifest before success is reported, so a failed export leaves no partial package at the " +
    "target.",
  kind: "workspace",
  inputSchema: z.object({
    id: templateId,
    version: templateVersion,
    target_dir: z.string().min(1).describe("Destination directory; must be absent or empty."),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    path: z.string(),
    id: z.string(),
    version: z.string(),
    digest: z.string(),
    files: z.array(packageFile),
    bytes: z.number().int().nonnegative(),
  }),
  effects: {
    readsFilesystem: true,
    writesFilesystem: true,
    network: false,
    spawnsProcess: false,
    mutatesTarget: true,
  },
  examples: [
    {
      description: "Export a package for inspection",
      input: { id: "acme-dashboard", version: "1.2.0", target_dir: "/home/dev/exported" },
    },
  ],
});

/** Remove one version, or a whole package id, through quarantine. */
export const templateRemoveContract = defineTool({
  name: "uvp_template_remove",
  title: "Remove a stored template package",
  description:
    "Remove one id@version, or every version of an id when version is omitted, from the local " +
    "store. The tree moves through quarantine; a failed cleanup is reported as `retained` " +
    "rather than treated as success. This does not touch any generated workspace.",
  kind: "workspace",
  inputSchema: z.object({
    id: templateId,
    version: templateVersion.optional().describe("Omit to remove every version of the id."),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    removed: z.string(),
    retained: z.string().optional(),
  }),
  effects: {
    readsFilesystem: true,
    writesFilesystem: true,
    network: false,
    spawnsProcess: false,
    mutatesTarget: true,
  },
  examples: [
    { description: "Remove one version", input: { id: "acme-dashboard", version: "1.2.0" } },
    { description: "Remove every version of an id", input: { id: "acme-dashboard" } },
  ],
});
