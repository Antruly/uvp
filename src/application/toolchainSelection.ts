import { UvpFailure } from "../domain/errors.js";
import {
  TOOLCHAIN_KINDS,
  type ToolchainKind,
  type ToolchainSelection,
} from "../domain/toolchain.js";
import type { WorkspaceManifest } from "./workspaceManifest.js";

/**
 * Which toolchain a call will use.
 *
 * Two inputs, one rule, and the rule is asymmetric on purpose: **a workspace may
 * ask for a container, and a call may refuse one — but only a workspace can name
 * an image.** `uvp build --toolchain container` insists on a container and fails
 * if the workspace names none; it cannot conjure an image out of a flag. That is
 * the whole of the authority model, and it is here rather than in a handler
 * because three workflows ask this question and a rule stated three times is
 * three rules.
 *
 * The asymmetry is what keeps starting a container from being a side effect of a
 * request that never mentioned one. Building in an image means running a process
 * on this host under that image's user, mounting the workspace into it, and
 * discarding whatever it writes elsewhere — a caller who wants that says so in a
 * file inside the workspace, where it is reviewable and versioned, not in an
 * argument that leaves no trace.
 *
 * A declaration that cannot be read is an error, never a fallback. Everything
 * else in a manifest degrades to "unknown" when it is malformed, because a
 * malformed observation is one uvp can simply not make. A malformed toolchain
 * declaration is an instruction, and the only fallback available is the opposite
 * one — build on this host, where the workspace said not to.
 */
export const selectToolchain = (input: {
  readonly manifest?: WorkspaceManifest | undefined;
  /** What the call itself asked for, when it asked. */
  readonly requested?: ToolchainKind | undefined;
}): ToolchainSelection => {
  const declared = input.manifest?.toolchain;
  const problem = input.manifest?.toolchainProblem;
  const manifestName = input.manifest?.path ?? "uvp.json";

  if (problem !== undefined) {
    throw new UvpFailure({
      code: "invalid_request",
      message: `The workspace's ${manifestName} declares a toolchain that cannot be read: ${problem}`,
      remediation: {
        action:
          'Write it as {"kind": "container", "image": "<reference>"} or {"kind": "local"}, or remove ' +
          "the field to build with this host's own compilers.",
      },
      details: { manifest: manifestName },
    });
  }

  if (input.requested === "local") {
    return { kind: "local" };
  }

  if (input.requested === "container") {
    if (declared?.kind === "container") return declared;
    throw new UvpFailure({
      code: "missing_requirement",
      message: `This call asked to build in a container, and ${manifestName} names no image to build in.`,
      remediation: {
        action:
          'Add {"toolchain": {"kind": "container", "image": "<reference>"}} to uvp.json. A call can ' +
          "require a container toolchain, but only the workspace can name the image.",
      },
      details: { requested: [...TOOLCHAIN_KINDS], declared: declared?.kind ?? null },
    });
  }

  // Nothing asked for anything, so the workspace's own declaration stands — and
  // in its absence, this host. `local` is the default because it is the one that
  // starts nothing: a workspace that says nothing about where it is built is
  // built where it is read.
  return declared ?? { kind: "local" };
};
