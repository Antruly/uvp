import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Repository-relative paths, resolved once.
 *
 * Scripts are invoked from the repository root by npm and from arbitrary
 * directories when someone runs `node scripts/…` directly. Deriving the root from
 * this module's own location makes both cases work, which matters because the
 * second case is how you debug the first.
 */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const DIST_DIR = path.join(REPO_ROOT, "dist");

/** Path to a compiled module under `dist/`, using the directory of the caller. */
export const distModule = (relative) => path.join(DIST_DIR, relative);

/**
 * Import a compiled module and fail with a useful message when `dist/` is not
 * built.
 *
 * A generator that reports "Cannot find module ./dist/…" sends the reader
 * looking for a bug in the generator. Saying which npm script to run does not.
 */
export const importCompiled = async (relative) => {
  try {
    return await import(distModule(relative));
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND") {
      console.error(`Cannot load dist/${relative}.`);
      console.error("Build first: npm run compile");
      process.exit(2);
    }
    throw error;
  }
};
