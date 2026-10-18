import { Buffer } from "node:buffer";

import { UvpFailure } from "../domain/errors.js";
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
  /** Exactly the routes the package declared, or none. */
  readonly routes: readonly string[];
  /** Present when the package declared no routes; the caller reports it. */
  readonly routesLimitation?: string;
}

const MANIFEST_FILE = "uvp.json";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

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
  const fields: WorkspaceManifestFields = {
    name: input.name,
    binary: input.name,
    port: input.port,
    features,
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
    routes: pkg.routes ?? [],
    ...(pkg.routes === undefined ? { routesLimitation: "The package declares no routes." } : {}),
  };
};
