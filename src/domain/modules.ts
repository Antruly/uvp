import type { UvpFeature } from "./features.js";

/**
 * The application-module vocabulary.
 *
 * A module is a piece of a generated *service* — a health route, a bounded echo
 * log, a WebSocket echo endpoint, a static test console — and it is a different
 * thing from a `UvpFeature`. A feature is a libuvcpp build switch: code that the
 * library either has or does not have, reported by `uvp doctor` and guarded in
 * the generated source. A module is uvp's own composition unit: generated C++
 * that uvp writes, assembled into a project at `uvp init` time. One can require
 * the other — `websocket-echo` is written against libuvcpp's `websocket` module
 * — but they are not interchangeable, and the reason this file exists is to keep
 * the two vocabularies from being mistaken for each other.
 *
 * The set is closed on purpose. `uvp init --modules` is a request to compose
 * known pieces, not a plugin system: an unknown name is refused rather than
 * ignored, because a project whose manifest listed a module with no code behind
 * it would be a claim the source does not support.
 */
export const UVP_MODULES = ["health", "echo-log", "websocket-echo", "static-console"] as const;

export type UvpModule = (typeof UVP_MODULES)[number];

export interface UvpModuleDefinition {
  /** What a caller gets, in the words `uvp init --modules` would use. */
  readonly description: string;
  /**
   * Libuvcpp features whose headers and symbols this module's source uses.
   *
   * A module whose feature is absent is refused at `uvp init`, before any file
   * is written: the generated project would fail to compile, or compile against
   * a module that is stubbed out, and neither is a useful first result.
   */
  readonly requiresFeatures: readonly UvpFeature[];
  /** Other modules whose generated code this one calls into. */
  readonly requiresModules: readonly UvpModule[];
  /**
   * The routes it registers, as `METHOD /path`, in registration order.
   *
   * `WS` marks a WebSocket endpoint. Exact-path routes are what conflicts are
   * decided on: `GET /healthz` and `GET /healthz/` are different registrations,
   * so a prefix that merely overlaps is not a conflict. A static subtree is
   * listed the same way — its prefix and `/*path`, each for `GET` and `HEAD` —
   * because those are the registrations it actually adds.
   */
  readonly routes: readonly string[];
  /** Files it adds to the workspace, beside the generated source and manifest. */
  readonly assets: readonly string[];
}

export const UVP_MODULE_DEFINITIONS: Readonly<Record<UvpModule, UvpModuleDefinition>> = {
  health: {
    description: "a GET /healthz route that answers {status:ok}",
    requiresFeatures: [],
    requiresModules: [],
    routes: ["GET /healthz"],
    assets: [],
  },
  "echo-log": {
    description:
      "a bounded in-memory log of received messages and a GET /api/echo-log route that reports it",
    requiresFeatures: [],
    requiresModules: [],
    routes: ["GET /api/echo-log"],
    assets: [],
  },
  "websocket-echo": {
    description:
      "a WS /ws endpoint that echoes text and binary frames and reports ping/close on stdout",
    requiresFeatures: ["websocket"],
    requiresModules: [],
    routes: ["WS /ws"],
    assets: [],
  },
  "static-console": {
    description: "a public/index.html console that drives the echo and log routes, served from /",
    requiresFeatures: [],
    // The page has a Connect button (WS /ws) and a Load log button
    // (GET /api/echo-log); serving it without those routes would ship a page
    // whose controls answer 404 or never open.
    requiresModules: ["websocket-echo", "echo-log"],
    routes: ["GET /", "HEAD /", "GET /*path", "HEAD /*path"],
    assets: ["public/index.html"],
  },
};

export const isUvpModule = (value: string): value is UvpModule =>
  (UVP_MODULES as readonly string[]).includes(value);

/** The unknown names in a request, in first-seen order and without repeats. */
export const unknownModules = (names: readonly string[]): readonly string[] => {
  const unknown: string[] = [];
  for (const name of names) {
    if (!isUvpModule(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
};

/** The names a request gave more than once, in first-repeat order. */
export const duplicateModules = (names: readonly string[]): readonly UvpModule[] => {
  const seen = new Set<string>();
  const duplicated: UvpModule[] = [];
  for (const name of names) {
    if (!isUvpModule(name)) continue;
    if (seen.has(name)) {
      if (!duplicated.includes(name)) duplicated.push(name);
    } else {
      seen.add(name);
    }
  }
  return duplicated;
};

/**
 * The selected modules in the vocabulary's own order.
 *
 * Canonical order rather than the caller's, so two requests that name the same
 * modules generate the same file regardless of how the list was typed. The
 * generated source is a deliverable; making it depend on argument order would
 * make two identical workspaces diff.
 */
export const resolveModules = (names: readonly UvpModule[]): readonly UvpModule[] =>
  UVP_MODULES.filter((module) => names.includes(module));

/**
 * The modules a template composes when the caller names none.
 *
 * `websocket-test` is the template that *is* the four modules put together, so
 * its default is the full set and omitting `--modules` keeps the output it had
 * before the module layer existed. Every other template is a fixed program whose
 * default is no modules; there, `--modules` adds to what the template already
 * registers.
 */
export const defaultModules = (template: string): readonly UvpModule[] =>
  template === "websocket-test" ? UVP_MODULES : [];

/**
 * Why the selected modules cannot be used with these features, or `undefined`.
 *
 * Worded as the refusal `uvp init` prints: the caller can act on it without
 * reading the generated source.
 */
export const moduleFeatureProblem = (
  modules: readonly UvpModule[],
  features: readonly UvpFeature[],
): string | undefined => {
  const missing: UvpFeature[] = [];
  for (const module of modules) {
    for (const feature of UVP_MODULE_DEFINITIONS[module].requiresFeatures) {
      if (!features.includes(feature) && !missing.includes(feature)) missing.push(feature);
    }
  }
  if (missing.length === 0) return undefined;
  const requiring = modules.filter((module) =>
    UVP_MODULE_DEFINITIONS[module].requiresFeatures.some((feature) => missing.includes(feature)),
  );
  return (
    `the ${requiring.join(", ")} module${requiring.length === 1 ? "" : "s"} ` +
    `${requiring.length === 1 ? "needs" : "need"} the ` +
    `${missing.join(" and ")} feature${missing.length === 1 ? "" : "s"}, which this request ` +
    `does not include: pass --features ${[...new Set([...features, ...missing])].join(",")}`
  );
};

/**
 * Why a selected module is missing one it composes, or `undefined`.
 *
 * A module is not silently pulled in: the caller who asked for the console
 * should see that it needs the echo endpoint and the log, because the generated
 * page calls both.
 */
export const moduleDependencyProblem = (modules: readonly UvpModule[]): string | undefined => {
  for (const module of modules) {
    const missing = UVP_MODULE_DEFINITIONS[module].requiresModules.filter(
      (dependency) => !modules.includes(dependency),
    );
    if (missing.length > 0) {
      return (
        `the ${module} module composes ${missing.join(" and ")}, which ` +
        `${missing.length === 1 ? "is" : "are"} not selected: pass ` +
        `--modules ${[...modules, ...missing].join(",")}`
      );
    }
  }
  return undefined;
};

/**
 * Why a module cannot be added to a template that already serves its routes.
 *
 * The check is on the exact registration, which is how the generated app decides
 * it. The message names both sides so the caller can choose: drop the module, or
 * choose a template that does not already serve the path.
 */
export const moduleRouteConflictProblem = (
  modules: readonly UvpModule[],
  template: string,
  templateRouteList: readonly string[],
): string | undefined => {
  for (const module of modules) {
    for (const route of UVP_MODULE_DEFINITIONS[module].routes) {
      if (templateRouteList.includes(route)) {
        return (
          `the ${module} module registers ${route}, which the ${template} template already ` +
          `serves: drop ${module} from --modules, or choose a template that does not serve it`
        );
      }
    }
  }
  return undefined;
};
