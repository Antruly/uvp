/**
 * The built-in static frontend vocabulary.
 *
 * A frontend is a build-free page set — plain HTML, CSS, and JavaScript under
 * the workspace's served asset directory — and it is a different thing from a
 * `UvpModule`. A module contributes generated C++ that a service registers; a
 * frontend contributes files a browser loads. Neither implies the other: a
 * service with no page still answers routes, and a page does not need a module
 * to be served.
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
