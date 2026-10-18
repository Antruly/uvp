import type { TemplatePackageFramework } from "./templatePackage.js";

/**
 * The built-in frontend vocabulary.
 *
 * Two kinds of frontend live here. A *static page set* (`UvpFrontend`) is plain
 * HTML, CSS, and JavaScript under the workspace's served asset directory, built
 * by nothing. A *frontend app* (`UvpFrontendApp`) is a `frontend/` project whose
 * framework build writes `frontend/dist`, which the generated service serves
 * once it exists. Both are different things from a `UvpModule`: a module
 * contributes generated C++ that a service registers; a frontend contributes
 * files a browser loads. Neither implies the other — a service with no page
 * still answers routes, and a page does not need a module to be served.
 *
 * The set is closed for the same reason the module set is. `uvp init
 * --frontend` is a request for a known skin, not a plugin system: an unknown
 * name is refused rather than ignored, because a manifest naming a skin with no
 * files behind it would be a claim the workspace does not support.
 *
 * The pages are deliberately not templated against a framework. They use no
 * CDN, no external font, and no script that leaves the origin, so a generated
 * workspace still loads its frontend with no network beyond the local service.
 */
export const UVP_FRONTENDS = ["h5-minimal", "h5-dashboard", "h5-tech"] as const;

/**
 * The Node frontend apps, generated as a separate `frontend/` project.
 *
 * These are the three framework ids the template package format already names
 * (`TEMPLATE_PACKAGE_FRAMEWORKS`), and the type below ties them to it so the two
 * vocabularies cannot drift. An app is not a skin: it ships source a framework
 * build turns into `frontend/dist`, and the generated service serves that
 * output only once it exists.
 *
 * `uvp build` never runs the frontend build. A workspace generated with an app
 * is still an ordinary CMake project, and its service still starts — answering
 * `/` with a named "not built" response until someone runs the frontend build.
 * Node is an optional prerequisite for that one command, not for the project.
 */
export const UVP_FRONTEND_APPS = [
  "vue3",
  "react",
  "svelte",
] as const satisfies readonly TemplatePackageFramework[];

export type UvpFrontendApp = (typeof UVP_FRONTEND_APPS)[number];

export interface UvpFrontendAppDefinition {
  /** What a caller gets, in the words `uvp init --frontend` would use. */
  readonly description: string;
  /** The framework build's output directory, relative to the workspace root. */
  readonly output: string;
}

export const UVP_FRONTEND_APP_DEFINITIONS: Readonly<
  Record<UvpFrontendApp, UvpFrontendAppDefinition>
> = {
  vue3: {
    description: "a Vue 3 single-page app with a Vite build, served from frontend/dist",
    output: "frontend/dist",
  },
  react: {
    description: "a React single-page app with a Vite build, served from frontend/dist",
    output: "frontend/dist",
  },
  svelte: {
    description: "a Svelte single-page app with a Vite build, served from frontend/dist",
    output: "frontend/dist",
  },
};

/** The directory a Node frontend app is generated into, relative to the workspace root. */
export const FRONTEND_APP_DIRECTORY = "frontend";

export type UvpFrontend = (typeof UVP_FRONTENDS)[number];

export interface UvpFrontendDefinition {
  /** What a caller gets, in the words `uvp init --frontend` would use. */
  readonly description: string;
}

export const UVP_FRONTEND_DEFINITIONS: Readonly<Record<UvpFrontend, UvpFrontendDefinition>> = {
  "h5-minimal": {
    description: "a light, single-column page with a heading, a status line, and a local clock",
  },
  "h5-dashboard": {
    description: "a dark card grid with locally rendered status tiles and a count-up timer",
  },
  "h5-tech": {
    description: "a dark, monospace terminal-style page with a local render log",
  },
};

export const isUvpFrontend = (value: string): value is UvpFrontend =>
  (UVP_FRONTENDS as readonly string[]).includes(value);

/** The unknown names in a request, in first-seen order and without repeats. */
export const unknownFrontends = (names: readonly string[]): readonly string[] => {
  const unknown: string[] = [];
  for (const name of names) {
    if (!isUvpFrontend(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
};

/** The names a request asked for more than once, in first-repeat order. */
export const duplicateFrontends = (names: readonly string[]): readonly UvpFrontend[] => {
  const seen = new Set<string>();
  const duplicated: UvpFrontend[] = [];
  for (const name of names) {
    if (!isUvpFrontend(name)) continue;
    if (seen.has(name)) {
      if (!duplicated.includes(name)) duplicated.push(name);
    } else {
      seen.add(name);
    }
  }
  return duplicated;
};

/**
 * The selected frontends in the vocabulary's own order.
 *
 * Canonical order rather than the caller's, so two requests that name the same
 * skins generate the same files and the same manifest regardless of how the list
 * was typed. The generated workspace is a deliverable; making it depend on
 * argument order would make two identical workspaces diff.
 */
export const resolveFrontends = (names: readonly UvpFrontend[]): readonly UvpFrontend[] =>
  UVP_FRONTENDS.filter((frontend) => names.includes(frontend));

/** Every name a frontend selection may use, in the order the docs list them. */
export const UVP_FRONTEND_SELECTIONS = [...UVP_FRONTENDS, ...UVP_FRONTEND_APPS] as const;

export type UvpFrontendSelection = (typeof UVP_FRONTEND_SELECTIONS)[number];

export const isUvpFrontendApp = (value: string): value is UvpFrontendApp =>
  (UVP_FRONTEND_APPS as readonly string[]).includes(value);

export const isUvpFrontendSelection = (value: string): value is UvpFrontendSelection =>
  isUvpFrontend(value) || isUvpFrontendApp(value);

/** The unknown names in a request, in first-seen order and without repeats. */
export const unknownFrontendSelections = (names: readonly string[]): readonly string[] => {
  const unknown: string[] = [];
  for (const name of names) {
    if (!isUvpFrontendSelection(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
};

/** The selected names a request asked for more than once, in first-repeat order. */
export const duplicateFrontendSelections = (
  names: readonly string[],
): readonly UvpFrontendSelection[] => {
  const seen = new Set<string>();
  const duplicated: UvpFrontendSelection[] = [];
  for (const name of names) {
    if (!isUvpFrontendSelection(name)) continue;
    if (seen.has(name)) {
      if (!duplicated.includes(name)) duplicated.push(name);
    } else {
      seen.add(name);
    }
  }
  return duplicated;
};

/**
 * A validated frontend selection.
 *
 * `pages` are served from one `public/` document root; `app` is a `frontend/`
 * project that owns the document root itself. They cannot coexist — both would
 * claim `/` — so a selection with an app never carries pages and vice versa.
 */
export interface FrontendSelection {
  readonly pages: readonly UvpFrontend[];
  readonly app?: UvpFrontendApp;
}

/** The frontend apps a request names, in vocabulary order. */
export const selectedFrontendApps = (names: readonly string[]): readonly UvpFrontendApp[] =>
  UVP_FRONTEND_APPS.filter((app) => names.includes(app));

/**
 * The selection in the vocabulary's own order.
 *
 * Callers validate first (`unknownFrontendSelections`,
 * `duplicateFrontendSelections`, and the one-app rule); this only orders what
 * survives. Canonical order keeps two requests that name the same selection
 * byte-identical.
 */
export const resolveFrontendSelection = (
  names: readonly UvpFrontendSelection[],
): FrontendSelection => {
  const pages = resolveFrontends(names.filter(isUvpFrontend));
  const app = UVP_FRONTEND_APPS.find((candidate) => names.includes(candidate));
  return { pages, ...(app === undefined ? {} : { app }) };
};

/** The selection's names in canonical order, as the manifest records them. */
export const frontendSelectionNames = (
  selection: FrontendSelection,
): readonly UvpFrontendSelection[] => [
  ...selection.pages,
  ...(selection.app === undefined ? [] : [selection.app]),
];
