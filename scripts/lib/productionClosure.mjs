import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { repositoryPath } from "./generated-file.mjs";

/**
 * The packages a user installs, and who needs whom.
 *
 * Two generators describe this closure — `scripts/licenses.mjs` writes the
 * licences, `scripts/sbom.mjs` writes the bill of materials — and they have to
 * agree about it, because "this package is in the closure" is one fact and not
 * two. When each walked the graph itself, a change to one walk (an optional edge
 * followed, an alias resolved) would silently disagree with the other, and the
 * disagreement would be invisible: both files would still parse.
 *
 * ## Why the lockfile and not `node_modules`
 *
 * A tree that has been `npm install`ed differently on two machines produces two
 * different answers, and a tree can be stale: this repository's own
 * `node_modules` still holds packages the lockfile no longer resolves. The
 * lockfile is the artifact that was reviewed and committed, and it is the file
 * the version resolves from — so it is the file the licence and the digest belong
 * to.
 *
 * ## What "production" means, and what it does not
 *
 * The closure is the root's `dependencies` and everything they need, with
 * `devDependencies` never followed. That is what `npm install uvp-agents`
 * installs: uvp ships compiled JavaScript and no bundler, so a devDependency
 * reaches nobody. It is **not** a statement about the generated C++ projects,
 * which link a libuvcpp the user supplies and which uvp neither bundles nor
 * redistributes.
 *
 * Edges are followed through `dependencies` alone. `optionalDependencies` are
 * platform-conditional — the lockfile lists every platform's build of a native
 * package, and only one of them installs anywhere — so following them would
 * report binaries that no host ever receives. A package that declares them is
 * reported through `optionalHolders` instead of being guessed at.
 */

/** The last `node_modules/` segment is the one that owns the package. */
const nameOf = (location) =>
  location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length);

/**
 * Resolve a dependency name from a location in the tree.
 *
 * npm hoists aggressively, so the root `node_modules` answers almost every
 * lookup; the upward walk handles the cases it does not, including a nested copy
 * that exists because of a version conflict.
 */
const resolver = (packages) => (fromPath, name) => {
  let current = fromPath;
  for (;;) {
    const candidate = current === "" ? `node_modules/${name}` : `${current}/node_modules/${name}`;
    if (packages[candidate] !== undefined) return candidate;
    if (current === "") return undefined;
    const cut = current.lastIndexOf("/node_modules/");
    current = cut === -1 ? "" : current.slice(0, cut);
  }
};

const byName = (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

/**
 * Walk the production closure of a parsed `package-lock.json`.
 *
 * Returns `{ entries, unresolved, optionalHolders, lockfileVersion }`. Throws
 * when the lockfile has no `packages` map — a lockfile that predates
 * lockfileVersion 2 cannot be read here, and answering "no dependencies" would
 * be a wrong answer rather than a missing one.
 */
export const productionClosure = (lock) => {
  const packages = lock?.packages ?? {};
  if (Object.keys(packages).length === 0) {
    throw new Error(
      "package-lock.json has no `packages` map; it predates lockfileVersion 2. Run `npm install` to regenerate it.",
    );
  }

  const root = packages[""] ?? {};
  const resolve = resolver(packages);
  const rootOptional = new Set(Object.keys(root.optionalDependencies ?? {}));

  const records = new Map();
  const unresolved = new Set();
  const queue = Object.keys(root.dependencies ?? {}).map((name) => ({ name, from: "" }));

  while (queue.length > 0) {
    const { name, from } = queue.shift();
    const location = resolve(from, name);
    if (location === undefined) {
      unresolved.add(name);
      continue;
    }
    if (records.has(location)) continue;

    const entry = packages[location];
    const edges = [];
    for (const nested of Object.keys(entry.dependencies ?? {})) {
      const nestedLocation = resolve(location, nested);
      // An edge this walk cannot resolve is still queued: the queue reports it
      // once, by name, and the record is left out of the graph rather than
      // pointed at a location the lockfile does not have.
      if (nestedLocation !== undefined && !edges.includes(nestedLocation)) {
        edges.push(nestedLocation);
      }
      queue.push({ name: nested, from: location });
    }

    records.set(location, {
      // The package's own name, read from where it sits, not the name that
      // requested it: an aliased dependency (`npm:other@1`) is requested under
      // one name and installed under another, and the installed one is the
      // package.
      name: nameOf(location),
      location,
      requested_as: name,
      version: entry.version ?? null,
      license: typeof entry.license === "string" ? entry.license : null,
      direct: from === "",
      optional: rootOptional.has(name),
      resolved: entry.resolved ?? null,
      integrity: entry.integrity ?? null,
      dependencies: edges.sort(),
    });
  }

  const entries = [...records.values()].sort(byName);

  // Declared but not followed, so the caller can say so rather than let a reader
  // assume the closure is complete for platforms this walk never looked at.
  const optionalHolders = entries
    .filter((entry) => Object.keys(packages[entry.location]?.optionalDependencies ?? {}).length > 0)
    .map((entry) => entry.name);

  return {
    entries,
    unresolved: [...unresolved].sort(),
    optionalHolders,
    lockfileVersion: lock.lockfileVersion ?? null,
  };
};

/**
 * Read and walk `package-lock.json`, with the digest of the bytes that were read.
 *
 * The digest is what lets a generated file say which tree it describes: two
 * lockfiles can produce the same closure today and diverge tomorrow, and a
 * reader comparing a bill of materials against a checkout has nothing else to
 * compare against.
 */
export const loadProductionClosure = async () => {
  const raw = await readFile(repositoryPath("package-lock.json"), "utf8");
  const lock = JSON.parse(raw);
  return {
    lock,
    lockfileSha512: createHash("sha512").update(raw, "utf8").digest("hex"),
    ...productionClosure(lock),
  };
};
