import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isUvpFeature, type UvpFeature } from "../domain/features.js";
import { isToolchainKind, type ToolchainSelection } from "../domain/toolchain.js";

/**
 * The `uvp.json` a workspace carries.
 *
 * The manifest is read, never trusted: every field is treated as absent until it
 * has been checked, because a workspace can be hand-edited and a malformed
 * manifest must degrade to "unknown" rather than to a wrong answer. That is also
 * why an unreadable or invalid manifest returns `undefined` instead of throwing:
 * a directory that is not a uvp workspace is a legitimate thing to point the
 * doctor at.
 */
export interface WorkspaceManifest {
  readonly name: string;
  readonly binary?: string;
  readonly port?: number;
  readonly template?: string;
  /**
   * The transport this workspace's service answers on.
   *
   * Derived from `features` rather than read from a field of its own, and that is
   * the point: a manifest that stated the transport twice could state it
   * differently, and the feature list is already the thing `uvp doctor
   * --workspace` is answered from. `tls` is the one feature that changes how a
   * caller reaches the service, and a generated workspace that declares it serves
   * HTTPS or refuses to start — so a caller that reads `https` from here is not
   * guessing about the port's traffic, it is reading the workspace's declaration
   * of it.
   */
  readonly scheme: "http" | "https";
  /** Features the workspace declares it needs. Unknown names are dropped. */
  readonly features: readonly UvpFeature[];
  /** Feature names that were present but not recognised, kept so they can be reported. */
  readonly unrecognisedFeatures: readonly string[];
  readonly requiredLibuvcpp?: string;
  /**
   * The toolchain this workspace asks to be built with.
   *
   * This is the one field of a `uvp.json` that is an instruction rather than an
   * observation, and it is why it is reported the way it is: every other field
   * here degrades to "unknown" when it cannot be read, but a toolchain
   * declaration that degrades to "local" is a build that happens on this host
   * when the workspace said it must not. `toolchainProblem` is what keeps that
   * from being silent — a caller that finds it must refuse rather than fall
   * back, and `selectToolchain` is where that refusal is written once.
   */
  readonly toolchain?: ToolchainSelection;
  /** Why `toolchain` is absent although the file carried a `toolchain` field. */
  readonly toolchainProblem?: string;
  readonly path: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Read the `toolchain` field, or say why it could not be read.
 *
 * Never both, and never neither: a declaration that is present must produce
 * either a selection or a reason. The two shapes that would otherwise slip
 * through are a container with no image (nothing to build in) and a local
 * toolchain beside an image (a declaration whose halves disagree), and both are
 * reported rather than resolved — picking the half that works is how a workspace
 * ends up built somewhere it did not ask for.
 */
const readToolchain = (
  value: unknown,
): { readonly toolchain?: ToolchainSelection; readonly problem?: string } => {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    return { problem: "`toolchain` is present and is not an object." };
  }
  const kind = value["kind"];
  if (!isToolchainKind(kind)) {
    return {
      problem: `\`toolchain.kind\` is ${JSON.stringify(kind)} rather than one of local, container.`,
    };
  }
  const image = asString(value["image"]);
  if (kind === "local") {
    return image === undefined && !("image" in value)
      ? { toolchain: { kind: "local" } }
      : {
          problem:
            "`toolchain` asks for the local toolchain and names an image, which would be ignored.",
        };
  }
  return image === undefined
    ? { problem: "`toolchain` asks for a container toolchain and names no image." }
    : { toolchain: { kind: "container", image } };
};

export const readWorkspaceManifest = async (
  root: string,
  manifestName = "uvp.json",
): Promise<WorkspaceManifest | undefined> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(root, manifestName), "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const rawFeatures = Array.isArray(parsed["features"]) ? parsed["features"] : [];
  const features: UvpFeature[] = [];
  const unrecognised: string[] = [];
  for (const entry of rawFeatures) {
    if (typeof entry !== "string") continue;
    if (isUvpFeature(entry)) features.push(entry);
    else unrecognised.push(entry);
  }

  const requirements = isRecord(parsed["requirements"]) ? parsed["requirements"] : {};

  // Each optional field is read once and spread only when it is a non-empty
  // string. Calling the reader twice reads well and defeats narrowing, which is
  // how this file first failed to compile under `exactOptionalPropertyTypes`.
  const binary = asString(parsed["binary"]);
  const template = asString(parsed["template"]);
  const requiredLibuvcpp = asString(requirements["libuvcpp"]);
  const port = parsed["port"];
  const { toolchain, problem: toolchainProblem } = readToolchain(parsed["toolchain"]);

  return {
    name: asString(parsed["name"]) ?? "app",
    ...(binary === undefined ? {} : { binary }),
    ...(typeof port === "number" && Number.isInteger(port) ? { port } : {}),
    ...(template === undefined ? {} : { template }),
    // `https` only for a workspace that declares `tls`, and for no other reason.
    // A workspace with no manifest at all is not read here — the caller gets
    // `undefined` and applies its own default, so "no manifest" stays
    // distinguishable from "a manifest that declares cleartext".
    scheme: features.includes("tls") ? "https" : "http",
    features,
    unrecognisedFeatures: unrecognised,
    ...(requiredLibuvcpp === undefined ? {} : { requiredLibuvcpp }),
    ...(toolchain === undefined ? {} : { toolchain }),
    ...(toolchainProblem === undefined ? {} : { toolchainProblem }),
    path: join(root, manifestName),
  };
};
