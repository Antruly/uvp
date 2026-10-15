import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isUvpFeature, type UvpFeature } from "../domain/features.js";

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
  readonly path: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

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
    path: join(root, manifestName),
  };
};
