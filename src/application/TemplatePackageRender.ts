import { Buffer } from "node:buffer";

import { UvpFailure } from "../domain/errors.js";
import {
  isUvpFrontendApp,
  isUvpFrontendSelection,
  type UvpFrontendApp,
  type UvpFrontendSelection,
} from "../domain/frontends.js";
import type { StoredTemplatePackageSource } from "./TemplateStore.js";

/**
 * Render a stored template package into the files of a generated workspace.
 *
 * The package is data: this module performs the three v1 placeholder
 * substitutions, copies binary files unchanged, and adds the `template_package`
 * record `uvp.json` needs to say where the workspace came from. It does not run
 * anything the package ships, and it does not read the package's source to
 * infer what that source serves — routes come from the manifest or the result
 * says the package declared none.
 *
 * ## Placeholders
 *
 * `{{project.name}}` and `{{project.port}}` come from the init inputs;
 * `{{features}}` from `requires.features`, comma-separated in manifest order.
 * Substitution is textual, so a package controls its own quoting — a manifest
 * that writes `"port": {{project.port}}` renders a JSON number and one that
 * writes `"port": "{{project.port}}"` renders a string, which the workspace
 * manifest reader will then refuse as it would any other bad field.
 *
 * Only files that decode as UTF-8 are substituted. A file that does not decode
 * is copied byte-for-byte: rewriting bytes that are not text would corrupt an
 * image or an icon to no purpose.
 *
 * ## `uvp.json`
 *
 * A package may ship its own `uvp.json`; this module renders it, removes
 * `template` (the two selectors are mutually exclusive), and adds
 * `template_package`. Every other field is preserved, including a `binary` name
 * that differs from the project name. A package without one gets a minimal
 * manifest generated here, so `uvp build` and `uvp run` have the record they
 * read. This is the one file uvp writes rather than copies.
 *
 * ## Frontends
 *
 * A package that carries a Node app under `frontend/` has to record it in
 * `frontends`, or `uvp frontend build` refuses with "records no Node frontend
 * app in uvp.json" even though the app is right there. The package's declared
 * `framework` (vue3, react, svelte) answers the question when it is one of the
 * app ids; otherwise the dependency name in `frontend/package.json` does. Only
 * a package with a `frontend/package.json` gets the record — a static page set
 * or a package whose source happens to be a Vue file is not an app build.
 */

export interface PackageWorkspaceRenderInput {
  readonly source: StoredTemplatePackageSource;
  readonly name: string;
  readonly port: number;
}

export interface RenderedPackageFile {
  readonly path: string;
  readonly content: Uint8Array;
}

export interface RenderedPackageWorkspace {
  readonly files: readonly RenderedPackageFile[];
  /**
   * The binary name the workspace manifest names, or the project name when the
   * package's manifest names none. `uvp run` reads the same field.
   */
  readonly binary: string;
  /** The Node frontend app recorded in the manifest, or none. */
  readonly frontends: readonly UvpFrontendSelection[];
  /** Exactly the routes the package declared, or none. */
  readonly routes: readonly string[];
  /** Present when the package declared no routes; the caller reports it. */
  readonly routesLimitation?: string;
}

const MANIFEST_FILE = "uvp.json";
const FRONTEND_PACKAGE_FILE = "frontend/package.json";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The dependency whose presence identifies each app, used when the package declares no framework. */
const FRONTEND_DEPENDENCY: Readonly<Record<UvpFrontendApp, string>> = {
  vue3: "vue",
  react: "react",
  svelte: "svelte",
};

/**
 * The app a package's `frontend/package.json` builds, when its dependencies name exactly one.
 *
 * A `package.json` may list both a framework and a tool that mentions another
 * (`@vitejs/plugin-vue` carries `vue` as a peer, not as a dependency), so only
 * the dependency keys themselves count. Two framework dependencies at once is
 * ambiguous and answered as unknown rather than guessed.
 */
const frontendAppFromDependencies = (
  files: readonly RenderedPackageFile[],
): UvpFrontendApp | undefined => {
  const manifest = files.find((file) => file.path === FRONTEND_PACKAGE_FILE);
  if (manifest === undefined) return undefined;
  const text = textOf(manifest.content);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const dependencies = {
    ...(isRecord(parsed["dependencies"]) ? parsed["dependencies"] : {}),
    ...(isRecord(parsed["devDependencies"]) ? parsed["devDependencies"] : {}),
  };
  const matches = (Object.keys(FRONTEND_DEPENDENCY) as UvpFrontendApp[]).filter(
    (app) => FRONTEND_DEPENDENCY[app] in dependencies,
  );
  return matches.length === 1 ? matches[0] : undefined;
};

const frontendAppOf = (
  source: StoredTemplatePackageSource,
  files: readonly RenderedPackageFile[],
): UvpFrontendApp | undefined => {
  if (!files.some((file) => file.path === FRONTEND_PACKAGE_FILE)) return undefined;
  const framework = source.package.framework;
  if (framework !== undefined && isUvpFrontendApp(framework)) return framework;
  return frontendAppFromDependencies(files);
};

const textOf = (bytes: Uint8Array): string | undefined => {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
};

const encode = (text: string): Uint8Array => Buffer.from(text, "utf8");

const packageDefect = (message: string, remediation: string): UvpFailure =>
  new UvpFailure({
    code: "invalid_request",
    message,
    remediation: { action: remediation },
  });

/**
 * Substitute every occurrence of the three v1 placeholders.
 *
 * Features are comma-separated because that is the spelling a C++ initialiser
 * or a CMake list can carry on one line; the manifest order is kept rather than
 * sorted so a package author can map the text back to `requires.features`.
 */
const substitute = (
  text: string,
  values: { readonly name: string; readonly port: number; readonly features: readonly string[] },
): string =>
  text
    .replaceAll("{{project.name}}", values.name)
    .replaceAll("{{project.port}}", String(values.port))
    .replaceAll("{{features}}", values.features.join(","));

const renderFile = (
  file: { readonly path: string; readonly bytes: Uint8Array },
  values: { readonly name: string; readonly port: number; readonly features: readonly string[] },
): RenderedPackageFile => {
  const text = textOf(file.bytes);
  return text === undefined
    ? { path: file.path, content: file.bytes }
    : { path: file.path, content: encode(substitute(text, values)) };
};

interface WorkspaceManifestFields {
  readonly name: string;
  readonly binary: string;
  readonly port: number;
  readonly features: readonly string[];
  readonly frontends?: readonly UvpFrontendSelection[];
  readonly libuvcpp?: string;
  readonly templatePackage: {
    readonly id: string;
    readonly version: string;
    readonly digest: string;
  };
}

const generatedManifest = (fields: WorkspaceManifestFields): Record<string, unknown> => ({
  uvp: 1,
  name: fields.name,
  binary: fields.binary,
  port: fields.port,
  features: [...fields.features],
  ...(fields.frontends === undefined ? {} : { frontends: [...fields.frontends] }),
  template_package: { ...fields.templatePackage },
  ...(fields.libuvcpp === undefined ? {} : { requirements: { libuvcpp: fields.libuvcpp } }),
});

/**
 * Merge the package's own `uvp.json` into a workspace manifest.
 *
 * `template` is removed rather than kept beside `template_package`: Q12 makes
 * the two mutually exclusive, and a workspace that named both would leave a
 * reader to choose which one described the actual source. A missing `binary`
 * falls back to the package's `name`, then to the init project name, so `uvp
 * run` has the same name the generated source was built under.
 */
const mergedManifest = (
  rendered: RenderedPackageFile,
  fields: WorkspaceManifestFields,
): { readonly file: RenderedPackageFile; readonly binary: string } => {
  const text = textOf(rendered.content);
  if (text === undefined) {
    throw packageDefect(
      "The package's uvp.json is not UTF-8 text, so it cannot be merged into a workspace manifest.",
      "Replace uvp.json in the package with a JSON text file, then import it again.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw packageDefect(
      "The package's uvp.json is not valid JSON.",
      "Fix uvp.json in the package, then import it again.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw packageDefect(
      "The package's uvp.json must contain a JSON object.",
      "Fix uvp.json in the package, then import it again.",
    );
  }
  const manifest = { ...(parsed as Record<string, unknown>) };
  delete manifest["template"];
  manifest["template_package"] = { ...fields.templatePackage };
  if (manifest["frontends"] === undefined && fields.frontends !== undefined) {
    manifest["frontends"] = [...fields.frontends];
  }
  const named = manifest["binary"];
  const binary =
    typeof named === "string" && named.length > 0
      ? named
      : typeof manifest["name"] === "string" && manifest["name"].length > 0
        ? manifest["name"]
        : fields.binary;
  if (typeof named !== "string" || named.length === 0) manifest["binary"] = binary;
  return {
    file: { path: rendered.path, content: encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    binary,
  };
};

/**
 * The `frontends` a rendered manifest records, in its own order.
 *
 * Read back rather than assumed: a package's own `uvp.json` may have declared
 * frontends, and the init result must report what the workspace actually says.
 * Entries are not filtered by the selection vocabulary here — the manifest
 * reader already refuses an unknown one, and this function's caller reports the
 * file that was written.
 */
const recordedFrontends = (
  files: readonly RenderedPackageFile[],
): readonly UvpFrontendSelection[] => {
  const file = files.find((entry) => entry.path === MANIFEST_FILE);
  if (file === undefined) return [];
  const text = textOf(file.content);
  if (text === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return [];
    const value = parsed["frontends"];
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is UvpFrontendSelection =>
            typeof entry === "string" && isUvpFrontendSelection(entry),
        )
      : [];
  } catch {
    return [];
  }
};

/**
 * Render the package's declared files plus the workspace manifest.
 *
 * Paths are the manifest's own and were validated when the package was
 * imported; nothing here joins a package path with a caller-supplied one.
 */
export const renderTemplatePackageWorkspace = (
  input: PackageWorkspaceRenderInput,
): RenderedPackageWorkspace => {
  const pkg = input.source.package;
  const features = pkg.requires?.features ?? [];
  const rendered = input.source.files.map((file) =>
    renderFile(file, { name: input.name, port: input.port, features }),
  );
  const inferredFrontend = frontendAppOf(input.source, rendered);
  const fields: WorkspaceManifestFields = {
    name: input.name,
    binary: input.name,
    port: input.port,
    features,
    ...(inferredFrontend === undefined ? {} : { frontends: [inferredFrontend] }),
    ...(pkg.requires?.libuvcpp === undefined ? {} : { libuvcpp: pkg.requires.libuvcpp }),
    templatePackage: { id: pkg.id, version: pkg.version, digest: pkg.digest },
  };

  const at = rendered.findIndex((file) => file.path === MANIFEST_FILE);
  let binary = input.name;
  if (at === -1) {
    rendered.push({
      path: MANIFEST_FILE,
      content: encode(`${JSON.stringify(generatedManifest(fields), null, 2)}\n`),
    });
  } else {
    const merged = mergedManifest(rendered[at] as RenderedPackageFile, fields);
    rendered[at] = merged.file;
    binary = merged.binary;
  }

  return {
    files: rendered,
    binary,
    frontends: recordedFrontends(rendered),
    routes: pkg.routes ?? [],
    ...(pkg.routes === undefined ? { routesLimitation: "The package declares no routes." } : {}),
  };
};
