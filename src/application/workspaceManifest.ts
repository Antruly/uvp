import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { UvpFailure } from "../domain/errors.js";
import {
  isUvpEventPayloadPolicy,
  type UvpEventPayloadPolicy,
} from "../domain/eventPayloadPolicy.js";
import { isUvpFeature, type UvpFeature } from "../domain/features.js";
import { isUvpFrontendSelection, type UvpFrontendSelection } from "../domain/frontends.js";
import { isUvpModule, type UvpModule } from "../domain/modules.js";
import { isToolchainKind, type ToolchainSelection } from "../domain/toolchain.js";

/**
 * The `uvp.json` a workspace carries.
 *
 * The manifest is read, never trusted: every field is treated as absent until it
 * has been checked, because a workspace can be hand-edited and a malformed field
 * must degrade to "unknown" rather than to a wrong answer.
 *
 * The read itself has three outcomes, and only one of them is "no manifest". No
 * file at all is ordinary — a directory that is not a uvp workspace is a
 * legitimate thing to point the doctor at. A file that is there and could not be
 * read, or parsed, is a different fact: it may declare a container build or the
 * features a caller is about to ignore, and folding it into "no manifest" is how
 * a workspace that said "do not build me here" was built on this host.
 * `WorkspaceManifestRead` keeps the two apart, and `manifestOf` is the one place
 * a caller says it has decided the difference does not matter.
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
  /**
   * The application modules the workspace records, when it records any.
   *
   * Absent means "the template's default set" (`defaultModules`), not "none":
   * `uvp init --template websocket-test` without `--modules` omits the field
   * because its generated source composes the full set, and every other
   * template's default is empty. `uvp init` writes the field only when the
   * selection differs from that default, so a reader decides the composition
   * from this field *and* `template`. An explicitly empty list means no modules.
   * A name this uvp does not know is reported through `unrecognisedModules`
   * rather than silently dropped.
   */
  readonly modules?: readonly UvpModule[] | undefined;
  /** Module names that were present but not recognised, kept so they can be reported. */
  readonly unrecognisedModules: readonly string[];
  /**
   * The static skins the workspace was generated with, when it records any.
   *
   * Absent means the workspace carries no skin; unlike `modules`, there is no
   * template default to fall back to. A name this uvp does not know is reported
   * through `unrecognisedFrontends` rather than silently dropped.
   */
  readonly frontends?: readonly UvpFrontendSelection[] | undefined;
  /** Frontend names that were present but not recognised, kept so they can be reported. */
  readonly unrecognisedFrontends: readonly string[];
  /**
   * What the evidence log was compiled to retain, when the workspace records it.
   *
   * `uvp init` writes this whenever `evidence-log` is selected, including for the
   * default `summary` policy, so a reader that finds it has the workspace's own
   * statement rather than a guess. Absent means the file does not record one — a
   * hand-written manifest, or one from a version that predates the field — and
   * the running service's `GET /api/events` is then the authority, not this
   * reader's default.
   */
  readonly evidence?: { readonly payloads: UvpEventPayloadPolicy };
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

/**
 * What reading a workspace's `uvp.json` established.
 *
 * `absent` is the ordinary case of a directory that is not a uvp workspace;
 * `unreadable` means there is a file and its declaration could not be honoured.
 * A caller that treats the second as the first is choosing this host, a default
 * feature set, or a default binary name on behalf of a workspace whose file says
 * something else — so the collapse is written here once and has to be named at
 * the call site.
 */
export type WorkspaceManifestRead =
  | { readonly state: "read"; readonly manifest: WorkspaceManifest }
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly problem: string };

/** The manifest when one was read, for callers that need the fields. */
export const manifestOf = (read: WorkspaceManifestRead): WorkspaceManifest | undefined =>
  read.state === "read" ? read.manifest : undefined;

/**
 * Why the file could not be used, when it could not be.
 *
 * Separate from `manifestOf` so a caller that must refuse can ask both
 * questions without re-deciding which state it is looking at.
 */
export const manifestProblemOf = (read: WorkspaceManifestRead): string | undefined =>
  read.state === "unreadable" ? read.problem : undefined;

/**
 * The refusal a manifest that could not be used deserves.
 *
 * One sentence for every boundary that has to say it: the file exists, uvp could
 * not read what it asks for, and the only honest alternatives are repair or
 * removal — not "assume this host".
 */
export const manifestProblemFailure = (problem: string): UvpFailure =>
  new UvpFailure({
    code: "invalid_request",
    message: `The workspace's manifest cannot be used: ${problem}.`,
    remediation: {
      action:
        "Repair the file, or remove it if this workspace has no declaration to make. uvp will not " +
        "substitute this host's compilers, features, or binary for a declaration it could not read.",
    },
  });

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

/** Why the file could not be read, in terms a caller can act on. */
const describeReadFailure = (cause: unknown): string => {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM") return "this process may not read it";
  if (code === "EISDIR") return "that path is a directory";
  if (code === "ELOOP") return "it is a symlink loop";
  if (code === "ENAMETOOLONG") return "the path is too long";
  return cause instanceof Error ? cause.message : String(cause);
};

export const readWorkspaceManifest = async (
  root: string,
  manifestName = "uvp.json",
): Promise<WorkspaceManifestRead> => {
  let text: string;
  try {
    text = await readFile(join(root, manifestName), "utf8");
  } catch (cause) {
    // `ENOENT`/`ENOTDIR` are the two ways the path is simply not there, and that
    // is the ordinary "not a uvp workspace" answer. Any other failure is a file
    // that may well exist and was not read, which is not absence.
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "absent" };
    return {
      state: "unreadable",
      problem: `${manifestName} could not be read (${describeReadFailure(cause)})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return {
      state: "unreadable",
      problem:
        `${manifestName} is not valid JSON ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }
  if (!isRecord(parsed)) {
    // Parsed, and not an object: there is a file, and every field read below
    // would answer "absent" about a declaration that may be there in a shape
    // this reader does not know. That is not the same as no file.
    return { state: "unreadable", problem: `${manifestName} is not a JSON object` };
  }

  const rawFeatures = Array.isArray(parsed["features"]) ? parsed["features"] : [];
  const features: UvpFeature[] = [];
  const unrecognised: string[] = [];
  for (const entry of rawFeatures) {
    if (typeof entry !== "string") continue;
    if (isUvpFeature(entry)) features.push(entry);
    else unrecognised.push(entry);
  }

  // A `modules` field that is present has to be readable: absent means the
  // template's default, and folding a malformed declaration into "absent" would
  // answer the default on behalf of a file that said something else. Unknown
  // names are a different matter — they are reported, like unknown features,
  // rather than making the whole manifest unusable.
  const modulesValue = parsed["modules"];
  const modules: UvpModule[] = [];
  const unrecognisedModules: string[] = [];
  if (modulesValue !== undefined) {
    if (!Array.isArray(modulesValue)) {
      return {
        state: "unreadable",
        problem: `${manifestName} declares \`modules\` and it is not a list`,
      };
    }
    for (const entry of modulesValue) {
      if (typeof entry !== "string") {
        return {
          state: "unreadable",
          problem: `${manifestName} declares a \`modules\` entry that is not a string`,
        };
      }
      if (isUvpModule(entry)) modules.push(entry);
      else unrecognisedModules.push(entry);
    }
  }

  // Like `modules`, a present `frontends` field has to be readable: absent means
  // no skin, and folding a malformed declaration into "absent" would answer
  // "no skin" on behalf of a file that said something else.
  const frontendsValue = parsed["frontends"];
  const frontends: UvpFrontendSelection[] = [];
  const unrecognisedFrontends: string[] = [];
  if (frontendsValue !== undefined) {
    if (!Array.isArray(frontendsValue)) {
      return {
        state: "unreadable",
        problem: `${manifestName} declares \`frontends\` and it is not a list`,
      };
    }
    for (const entry of frontendsValue) {
      if (typeof entry !== "string") {
        return {
          state: "unreadable",
          problem: `${manifestName} declares a \`frontends\` entry that is not a string`,
        };
      }
      if (isUvpFrontendSelection(entry)) frontends.push(entry);
      else unrecognisedFrontends.push(entry);
    }
  }

  // Like `modules`, a present `evidence` field has to be readable. Answering the
  // default policy for a file that declared another one would describe
  // collection that did not happen the way the file says.
  const evidenceValue = parsed["evidence"];
  let evidence: { readonly payloads: UvpEventPayloadPolicy } | undefined;
  if (evidenceValue !== undefined) {
    if (!isRecord(evidenceValue)) {
      return {
        state: "unreadable",
        problem: `${manifestName} declares \`evidence\` and it is not an object`,
      };
    }
    const payloads = evidenceValue["payloads"];
    if (typeof payloads !== "string" || !isUvpEventPayloadPolicy(payloads)) {
      return {
        state: "unreadable",
        problem:
          `${manifestName} declares \`evidence.payloads\` as ${JSON.stringify(payloads)} ` +
          "rather than one of summary, verbatim",
      };
    }
    evidence = { payloads };
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
    state: "read",
    manifest: {
      name: asString(parsed["name"]) ?? "app",
      ...(binary === undefined ? {} : { binary }),
      ...(typeof port === "number" && Number.isInteger(port) ? { port } : {}),
      ...(template === undefined ? {} : { template }),
      // `https` only for a workspace that declares `tls`, and for no other
      // reason. A workspace with no manifest at all is not read here — the
      // caller gets `absent` and applies its own default, so "no manifest"
      // stays distinguishable from "a manifest that declares cleartext".
      scheme: features.includes("tls") ? "https" : "http",
      features,
      unrecognisedFeatures: unrecognised,
      ...(modulesValue === undefined ? {} : { modules }),
      unrecognisedModules,
      ...(frontendsValue === undefined ? {} : { frontends }),
      unrecognisedFrontends,
      ...(evidence === undefined ? {} : { evidence }),
      ...(requiredLibuvcpp === undefined ? {} : { requiredLibuvcpp }),
      ...(toolchain === undefined ? {} : { toolchain }),
      ...(toolchainProblem === undefined ? {} : { toolchainProblem }),
      path: join(root, manifestName),
    },
  };
};
