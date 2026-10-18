import { resolve } from "node:path";

import { sha256 } from "../domain/identity.js";

/**
 * The id of the workspace at a path.
 *
 * Derived, not random: re-opening the same directory must yield the same id, so
 * an evidence record from an earlier call still refers to this workspace. It
 * lives here rather than beside the workspace service because more than one
 * workflow reports it, and two derivations would eventually disagree about the
 * same directory.
 */
export const workspaceIdOf = (path: string): string => {
  const digest = sha256(resolve(path));
  return `wsp_${digest.slice(0, 22)}`;
};
