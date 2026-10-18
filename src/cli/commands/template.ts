import {
  asBoolean,
  asList,
  asNumber,
  asString,
  flagError,
  parseCsv,
  requirePositional,
} from "../args.js";
import type { CommandSpec } from "../commandSpec.js";

/**
 * `uvp template ...`.
 *
 * Six commands, one per template-store contract. The store root is not a flag:
 * it is resolved by the store from `UVP_TEMPLATE_HOME` or `~/.uvp/templates`, so
 * the CLI and an agent use the same store without a second spelling.
 *
 * A package reference is `id@version` in the words a caller types, and the
 * contract receives the two fields separately. `get` and `export` require the
 * version; `remove` may omit it to remove every version of an id.
 */

const splitReference = (
  value: string,
  options: { readonly requireVersion: boolean; readonly usage: string },
): { readonly id: string; readonly version?: string } => {
  const at = value.indexOf("@");
  const id = at === -1 ? value : value.slice(0, at);
  if (id === "") {
    flagError(`"${value}" is not an id@version reference.`, { usage: options.usage });
  }
  if (at === -1) {
    if (options.requireVersion) {
      flagError(`"${value}" has no version; pass id@version.`, { usage: options.usage });
    }
    return { id };
  }
  if (value.indexOf("@", at + 1) !== -1) {
    flagError(`"${value}" is not an id@version reference.`, { usage: options.usage });
  }
  const version = value.slice(at + 1);
  if (version === "") {
    // A trailing `@` is not another spelling of "no version". Dropping the
    // empty segment would turn a typo in `remove` into a whole-id removal, so
    // the two spellings stay distinct: `id@x.y.z` names one version and a bare
    // `id` names every version.
    flagError(
      `"${value}" has no version after '@'; pass id@version` +
        (options.requireVersion ? "." : ", or omit the '@' to name every version."),
      { usage: options.usage },
    );
  }
  return { id, version };
};

const referencePositional = (
  name: string,
  description: string,
): { name: string; description: string } => ({
  name,
  description,
});

const booleanFlag = (name: string, description: string) => ({
  name,
  type: "boolean" as const,
  description,
});

const stringFlag = (name: string, value: string, description: string) => ({
  name,
  type: "string" as const,
  value,
  description,
});

export const templateSearchCommand: CommandSpec = {
  path: ["template", "search"],
  tool: "uvp_template_search",
  summary: "Search the locally installed template packages.",
  usage:
    "uvp template search [--text TEXT] [--category CATEGORY] [--framework FRAMEWORK] " +
    "[--tags LIST] [--tag-mode all|any] [--features LIST] [--version VERSION] " +
    "[--all-versions] [--limit N] [--offset N] [--json]",
  flags: [
    stringFlag("text", "TEXT", "Free text over id, name, description, tags, and features."),
    stringFlag("category", "CATEGORY", "frontend, backend, fullstack, or module."),
    stringFlag("framework", "FRAMEWORK", "h5, vue3, react, svelte, alpine, or htmx."),
    {
      name: "tags",
      type: "list",
      value: "LIST",
      description: "Comma-separated tags; every tag matches by default.",
    },
    stringFlag("tag-mode", "MODE", "all (default) or any."),
    {
      name: "features",
      type: "list",
      value: "LIST",
      description: "Comma-separated libuvcpp features the package must require.",
    },
    stringFlag("version", "VERSION", "Return exactly this version, across ids."),
    booleanFlag("all-versions", "Return every version; the default is the latest per id."),
    {
      name: "limit",
      type: "number",
      value: "N",
      description: "Matches per page, 1-100. Default 20.",
    },
    {
      name: "offset",
      type: "number",
      value: "N",
      description: "Matches to skip. Default 0.",
    },
  ],
  notes: [
    "The result is a proposal list, not a verdict: it includes a deterministic score and",
    "`matched_on`, but no model is called and no package is claimed to be best.",
    "Search reads metadata only; use `uvp template get` for a file list and `import` to add one.",
  ],
  input: (parsed) => {
    const text = asString(parsed, "text");
    const category = asString(parsed, "category");
    const framework = asString(parsed, "framework");
    const tags = parseCsv(asList(parsed, "tags"));
    const tagMode = asString(parsed, "tag-mode");
    const features = parseCsv(asList(parsed, "features"));
    const version = asString(parsed, "version");
    const allVersions = asBoolean(parsed, "all-versions");
    const limit = asNumber(parsed, "limit");
    const offset = asNumber(parsed, "offset");
    return {
      ...(text === undefined ? {} : { text }),
      ...(category === undefined ? {} : { category }),
      ...(framework === undefined ? {} : { framework }),
      ...(tags.length === 0 ? {} : { tags }),
      ...(tagMode === undefined ? {} : { tag_mode: tagMode }),
      ...(features.length === 0 ? {} : { features }),
      ...(version === undefined ? {} : { version }),
      ...(allVersions === undefined ? {} : { all_versions: allVersions }),
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
    };
  },
};

export const templateGetCommand: CommandSpec = {
  path: ["template", "get"],
  tool: "uvp_template_get",
  summary: "Read one stored template package and re-verify its files.",
  usage: "uvp template get ID@VERSION [--json]",
  positionals: [referencePositional("ID@VERSION", "Package id and exact version.")],
  input: (parsed) => {
    const reference = requirePositional(
      parsed,
      0,
      "an id@version reference",
      "uvp template get acme-dashboard@1.2.0",
    );
    return {
      ...splitReference(reference, {
        requireVersion: true,
        usage: "uvp template get acme-dashboard@1.2.0",
      }),
    };
  },
};

export const templateValidateCommand: CommandSpec = {
  path: ["template", "validate"],
  tool: "uvp_template_validate",
  summary: "Validate a package directory without importing it.",
  usage: "uvp template validate PATH [--allow-unverified] [--json]",
  positionals: [{ name: "PATH", description: "Package directory to validate." }],
  flags: [
    booleanFlag(
      "allow-unverified",
      "Admit a package whose only problems are licence/provenance, marked unverified.",
    ),
  ],
  notes: [
    "Validation checks the package format only. It does not compile the package and it does",
    "not check whether the same id@version is already in the store.",
  ],
  input: (parsed) => {
    const sourceDir = requirePositional(
      parsed,
      0,
      "a package directory",
      "uvp template validate ./acme-dashboard",
    );
    const allowUnverified = asBoolean(parsed, "allow-unverified");
    return {
      source_dir: sourceDir,
      ...(allowUnverified === undefined ? {} : { allow_unverified: allowUnverified }),
    };
  },
};

export const templateImportCommand: CommandSpec = {
  path: ["template", "import"],
  tool: "uvp_template_import",
  summary: "Validate, scan, and import a package into the local store.",
  usage: "uvp template import PATH [--replace] [--allow-unverified] [--dry-run] [--json]",
  positionals: [{ name: "PATH", description: "Package directory to import." }],
  flags: [
    booleanFlag("replace", "Replace an existing id@version explicitly; never implicit."),
    booleanFlag(
      "allow-unverified",
      "Admit a package whose only problems are licence/provenance, marked unverified.",
    ),
    booleanFlag("dry-run", "Validate and scan without writing to the store."),
  ],
  notes: [
    "The scan reports credential- and PII-shaped content with its own coverage; it is a",
    "bounded locator, not a guarantee that the package is clean.",
    "A package is not compiled on import; build a generated workspace for that evidence.",
  ],
  input: (parsed) => {
    const sourceDir = requirePositional(
      parsed,
      0,
      "a package directory",
      "uvp template import ./acme-dashboard",
    );
    const replace = asBoolean(parsed, "replace");
    const allowUnverified = asBoolean(parsed, "allow-unverified");
    const dryRun = asBoolean(parsed, "dry-run");
    return {
      source_dir: sourceDir,
      ...(replace === undefined ? {} : { replace }),
      ...(allowUnverified === undefined ? {} : { allow_unverified: allowUnverified }),
      ...(dryRun === undefined ? {} : { dry_run: dryRun }),
    };
  },
};

export const templateExportCommand: CommandSpec = {
  path: ["template", "export"],
  tool: "uvp_template_export",
  summary: "Copy a stored package to a directory.",
  usage: "uvp template export ID@VERSION --target DIR [--json]",
  positionals: [referencePositional("ID@VERSION", "Package id and exact version.")],
  flags: [stringFlag("target", "DIR", "Destination directory; it must be absent or empty.")],
  notes: [
    "The target must be absent or empty. The copy is verified against the manifest before",
    "success is reported, so a failed export leaves no partial package at the target.",
  ],
  input: (parsed) => {
    const reference = requirePositional(
      parsed,
      0,
      "an id@version reference",
      "uvp template export acme-dashboard@1.2.0 --target ./exported",
    );
    const target = asString(parsed, "target");
    if (target === undefined || target === "") {
      flagError("--target names the directory to export into.", {
        usage: "uvp template export acme-dashboard@1.2.0 --target ./exported",
      });
    }
    return {
      ...splitReference(reference, {
        requireVersion: true,
        usage: "uvp template export acme-dashboard@1.2.0 --target ./exported",
      }),
      target_dir: target,
    };
  },
};

export const templateRemoveCommand: CommandSpec = {
  path: ["template", "remove"],
  tool: "uvp_template_remove",
  summary: "Remove a stored package, or every version of an id.",
  usage: "uvp template remove ID[@VERSION] [--json]",
  positionals: [
    referencePositional("ID[@VERSION]", "Package id, optionally with an exact version."),
  ],
  notes: [
    "Without a version, every version of the id is removed. The removal moves the tree",
    "through quarantine; generated workspaces are not touched.",
  ],
  input: (parsed) => {
    const reference = requirePositional(
      parsed,
      0,
      "an id or id@version reference",
      "uvp template remove acme-dashboard@1.2.0",
    );
    return {
      ...splitReference(reference, {
        requireVersion: false,
        usage: "uvp template remove acme-dashboard@1.2.0",
      }),
    };
  },
};

export const templateCommands: readonly CommandSpec[] = [
  templateSearchCommand,
  templateGetCommand,
  templateValidateCommand,
  templateImportCommand,
  templateExportCommand,
  templateRemoveCommand,
];
