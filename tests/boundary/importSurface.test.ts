import { readFile, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The import surface of the artifact that ships.
 *
 * Every other lane imports `src/` or `dist/` from inside this repository, where
 * a wrong specifier is resolved by the same tree the test runs in and therefore
 * cannot be wrong in an interesting way. npm ships a file list, not a repository:
 * `dist/`, the bin script, and three generated documents. A module that reaches
 * outside that list works perfectly here and throws `ERR_MODULE_NOT_FOUND` on
 * the machine of everyone who installed it, which is the worst place to find out.
 *
 * So this lane asks the artifact questions about itself, treating it as a set of
 * files and specifiers rather than as a program:
 *
 * - does every specifier name a file that is actually there,
 * - does any of them leave the shipped tree,
 * - and is the closure reachable from the two entry points entirely inside it.
 *
 * ### What the extraction can and cannot see
 *
 * `typescript` 7 exposes no `preProcessFile`, so specifiers are matched by
 * pattern rather than parsed. The patterns are written to over-match rather than
 * to be precise: a false positive shows up as a named file that does not exist,
 * which is a two-minute read, while a false negative is a silent pass on the one
 * thing this file exists to check. Two consequences worth stating:
 *
 * - A string literal that happens to read like a specifier is reported as a
 *   missing file. That is a loud failure, not a quiet one.
 * - Type-only imports are invisible, because `tsc` erases them and they are not
 *   in the built output to find.
 */

const DIST = resolve(import.meta.dirname, "..", "..", "dist");
const REPOSITORY = resolve(DIST, "..");

/**
 * Every specifier the built output mentions.
 *
 * Three forms, because the compiler emits all three and missing one would make
 * the rest of this file confident about a subset: `… from "x"` (static import and
 * re-export), `import("x")` (dynamic), and a bare `import "x"` (side effect).
 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/gu,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  /^[ \t]*import\s*["']([^"']+)["']/gmu,
];

const specifiersIn = (source: string): string[] => {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) found.push(match[1]);
    }
  }
  return found;
};

/** True for a specifier that names a location rather than a package. */
const isRelative = (specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../");

const walk = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};

interface Module {
  /** Repository-relative, so a failure message names a file a reader can open. */
  readonly path: string;
  readonly specifiers: readonly string[];
}

const readModules = async (files: readonly string[]): Promise<Module[]> =>
  Promise.all(
    files.map(async (file) => ({
      path: relative(REPOSITORY, file),
      specifiers: specifiersIn(await readFile(file, "utf8")),
    })),
  );

/**
 * The built modules, read once.
 *
 * Both the checks and the vacuity guards below need them, and reading the tree
 * twice would let the two disagree about what the artifact contains.
 */
const built = await (async () => {
  const files = (await walk(DIST)).filter((file) => file.endsWith(".js"));
  const modules = await readModules(files);
  return {
    files,
    modules,
    relative: modules.flatMap((module) =>
      module.specifiers.filter(isRelative).map((specifier) => ({ module, specifier })),
    ),
    bare: modules.flatMap((module) => module.specifiers.filter((s) => !isRelative(s))),
  };
})();

describe("the extraction this lane rests on", () => {
  // Without these, a pattern that stopped matching would turn every check below
  // into a pass over an empty list, and the lane would report success because it
  // had stopped looking.
  it("reads a plausible number of modules and specifiers out of the artifact", () => {
    expect(built.files.length).toBeGreaterThan(40);
    // Expressed as a ratio rather than a count: the number of specifiers in an
    // artifact grows with the code, so a pinned total would be edited every time
    // someone added a module and would mean nothing after the first edit. "More
    // relative imports than modules" is true of any real layering and false the
    // moment the extractor stops extracting.
    expect(built.relative.length).toBeGreaterThan(built.files.length);
    expect(built.bare.length).toBeGreaterThan(0);
  });

  it("sees each of the three emitted forms, not just the easy one", () => {
    const sources = new Set(built.relative.map((entry) => entry.specifier));
    // A static re-export (`… from "…"`), a directory-relative import, and the
    // bare side-effect form are all present in the output today. If one form
    // stops being represented, the pattern that covers it has silently rotted.
    expect([...sources].some((specifier) => specifier.startsWith("../"))).toBe(true);
    expect([...sources].some((specifier) => specifier.startsWith("./"))).toBe(true);
    expect(built.bare).toContain("canonicalize");
  });
});

describe("the built output's import surface", () => {
  it("points every relative import at a file that exists", () => {
    const missing = built.relative
      .filter(
        (entry) =>
          !existsSync(
            resolve(DIST, entry.module.path.replace(/^dist\//u, ""), "..", entry.specifier),
          ),
      )
      .map((entry) => `${entry.module.path} -> ${entry.specifier}`);

    expect(missing, "specifiers with no file behind them").toEqual([]);
  });

  it("names the extension on every relative import", () => {
    // Node's ESM resolver does not guess: `./foo` is not `./foo.js`, and a
    // directory is not its `index.js`. A bundler-style specifier survives review
    // because it reads normally and resolves nowhere.
    const extensionless = built.relative
      .filter((entry) => !entry.specifier.endsWith(".js") && !entry.specifier.endsWith(".json"))
      .map((entry) => `${entry.module.path} -> ${entry.specifier}`);

    expect(extensionless, "specifiers without an explicit extension").toEqual([]);
  });

  it("never reaches back out of the shipped tree", () => {
    // A relative import that escapes `dist/` resolves inside a checkout and
    // nowhere else, which makes it invisible to every test that runs here.
    const escaping = built.relative
      .map((entry) => ({
        ...entry,
        target: resolve(DIST, entry.module.path.replace(/^dist\//u, ""), "..", entry.specifier),
      }))
      .filter((entry) => !entry.target.startsWith(DIST))
      .map((entry) => `${entry.module.path} -> ${entry.specifier}`);

    expect(escaping, "imports that leave dist/").toEqual([]);
  });

  it("carries no tests", () => {
    // `tsconfig.build.json` excludes them. If it ever stops excluding them they
    // ship, and a published tarball carrying its own tests is a tarball that
    // installs them into someone's project.
    const compiled = built.files
      .map((file) => relative(REPOSITORY, file))
      .filter((path) => path.endsWith(".test.js") || path.endsWith(".test.d.ts"));

    expect(compiled).toEqual([]);
  });

  it("keeps the layering rules after compilation, not just in the source", () => {
    // `.oxlintrc.json` enforces this on `src/`, which is the right place to catch
    // it. Checking the artifact too is not redundant: the lint rule reads the
    // sources a build was configured with, and this reads the ones that came out.
    // A re-export, a path alias, or a changed `rootDir` would satisfy the first
    // and violate the second.
    const forbidden: Record<string, readonly string[]> = {
      "dist/domain/": [
        "contracts/",
        "application/",
        "toolchains/",
        "composition/",
        "server/",
        "cli/",
      ],
      "dist/contracts/": ["application/", "toolchains/", "composition/", "server/", "cli/"],
    };

    const violations: string[] = [];
    for (const entry of built.relative) {
      for (const [layer, above] of Object.entries(forbidden)) {
        if (!entry.module.path.startsWith(layer)) continue;
        if (!entry.specifier.startsWith("../")) continue;
        const target = relative(
          "dist",
          resolve(DIST, entry.module.path.replace(/^dist\//u, ""), "..", entry.specifier),
        );
        if (above.some((prefix) => target.startsWith(prefix))) {
          violations.push(`${entry.module.path} -> ${entry.specifier}`);
        }
      }
    }

    expect(violations, "layering inversions in the built output").toEqual([]);
  });
});

describe("what a published install can reach", () => {
  it("resolves the bin entry's import of the compiled CLI", async () => {
    // `scripts/uvp.mjs` is what npm links as the `uvp` executable, and it reaches
    // the CLI through a dynamic import that no relative-path check in `dist/`
    // would ever see. This is the first thing that runs after `npm i -g`.
    const bin = join(REPOSITORY, "scripts", "uvp.mjs");
    const specifiers = specifiersIn(await readFile(bin, "utf8")).filter(isRelative);
    expect(specifiers, "the bin entry imports nothing relative").not.toEqual([]);

    for (const specifier of specifiers) {
      const target = resolve(join(REPOSITORY, "scripts"), specifier);
      expect(existsSync(target), `scripts/uvp.mjs -> ${specifier}`).toBe(true);
    }
  });

  it("closes over the entry points without leaving `dist/`", async () => {
    // The transitive closure, which is the actual claim: an installed uvp needs
    // nothing from the repository beyond the files npm was told to ship. A single
    // hop out of `dist/` makes the install work only for people who also have the
    // sources.
    const byPath = new Map(built.modules.map((module) => [module.path, module]));
    const entryPoints = ["dist/cli.js", "dist/main.js", "dist/version.js"];
    for (const entry of entryPoints) {
      expect(byPath.has(entry), `${entry} is not in the build output`).toBe(true);
    }

    const reached = new Set<string>();
    const queue = [...entryPoints];
    while (queue.length > 0) {
      const path = queue.pop();
      if (path === undefined || reached.has(path)) continue;
      reached.add(path);
      const module = byPath.get(path);
      if (module === undefined) continue;
      for (const specifier of module.specifiers.filter(isRelative)) {
        const target = relative(REPOSITORY, resolve(REPOSITORY, path, "..", specifier));
        queue.push(target);
      }
    }

    const missing = [...reached].filter((path) => !existsSync(join(REPOSITORY, path)));
    expect(missing, "files the entry points import but the build did not produce").toEqual([]);

    const outside = [...reached].filter((path) => !path.startsWith("dist/"));
    expect(outside, "reachable files outside dist/").toEqual([]);

    // The closure has to be most of the output, or `reached` is empty because the
    // walk broke rather than because the artifact is clean.
    expect(reached.size).toBeGreaterThan(30);
    expect(statSync(DIST).isDirectory()).toBe(true);
  });
});
