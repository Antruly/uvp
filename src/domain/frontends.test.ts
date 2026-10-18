import { describe, expect, it } from "vitest";

import {
  FRONTEND_APP_DIRECTORY,
  UVP_FRONTEND_APP_DEFINITIONS,
  UVP_FRONTEND_APPS,
  UVP_FRONTEND_SELECTIONS,
  UVP_FRONTENDS,
  duplicateFrontends,
  duplicateFrontendSelections,
  isUvpFrontend,
  isUvpFrontendApp,
  isUvpFrontendSelection,
  frontendSelectionNames,
  resolveFrontendSelection,
  resolveFrontends,
  selectedFrontendApps,
  unknownFrontends,
  unknownFrontendSelections,
} from "./frontends.js";
import { TEMPLATE_PACKAGE_FRAMEWORKS } from "./templatePackage.js";

describe("the static frontend vocabulary", () => {
  it("publishes the three built-in skins in the documented order", () => {
    // The order is the canonical order `uvp init` writes and a manifest records.
    // A skin added, removed, or renamed is a diff here rather than a silent
    // change to what every generated workspace lists.
    expect(UVP_FRONTENDS).toEqual(["h5-minimal", "h5-dashboard", "h5-tech"]);
  });

  it("recognises the vocabulary and nothing else", () => {
    for (const frontend of UVP_FRONTENDS) expect(isUvpFrontend(frontend)).toBe(true);
    for (const other of ["", "none", "h5", "h5-tech ", "H5-TECH", "vue"]) {
      expect(isUvpFrontend(other), other).toBe(false);
    }
  });

  it("names unknown entries once, in first-seen order", () => {
    expect(unknownFrontends(["vue", "h5-tech", "vue", "svelte"])).toEqual(["vue", "svelte"]);
    expect(unknownFrontends(UVP_FRONTENDS)).toEqual([]);
  });

  it("names repeats so the caller is refused rather than deduplicated", () => {
    expect(duplicateFrontends(["h5-tech", "h5-tech", "h5-dashboard"])).toEqual(["h5-tech"]);
    expect(duplicateFrontends(["h5-tech", "vue", "vue"])).toEqual([]);
  });

  it("resolves a selection to canonical order", () => {
    expect(resolveFrontends(["h5-tech", "h5-minimal"])).toEqual(["h5-minimal", "h5-tech"]);
    expect(resolveFrontends([])).toEqual([]);
  });
});

describe("the frontend app vocabulary", () => {
  it("names only frameworks the package format already accepts", () => {
    // The two vocabularies answer different questions — what a package may
    // declare, and what `uvp init` may generate — but an id in one and not the
    // other would be a package no init can reproduce. This is the assertion
    // that keeps that from drifting.
    for (const app of UVP_FRONTEND_APPS) {
      expect(TEMPLATE_PACKAGE_FRAMEWORKS, app).toContain(app);
    }
    expect(UVP_FRONTEND_APPS).toEqual(["vue3", "react", "svelte"]);
  });

  it("describes every app and points each at frontend/dist", () => {
    for (const app of UVP_FRONTEND_APPS) {
      const definition = UVP_FRONTEND_APP_DEFINITIONS[app];
      expect(definition.description.length, app).toBeGreaterThan(0);
      expect(definition.output, app).toBe(`${FRONTEND_APP_DIRECTORY}/dist`);
    }
  });

  it("keeps the app ids out of the static page-set vocabulary", () => {
    for (const app of UVP_FRONTEND_APPS) {
      expect(isUvpFrontend(app), app).toBe(false);
      expect(isUvpFrontendApp(app), app).toBe(true);
      expect(isUvpFrontendSelection(app), app).toBe(true);
    }
    for (const page of UVP_FRONTENDS) {
      expect(isUvpFrontendApp(page), page).toBe(false);
      expect(isUvpFrontendSelection(page), page).toBe(true);
    }
    // `h5` and `alpine` are package frameworks without a generator yet; a
    // selection naming one is refused rather than quietly mapped to a skin.
    for (const other of ["h5", "alpine", "htmx", "vue"]) {
      expect(isUvpFrontendSelection(other), other).toBe(false);
    }
  });

  it("lists selections as the page sets followed by the apps", () => {
    expect(UVP_FRONTEND_SELECTIONS).toEqual([...UVP_FRONTENDS, ...UVP_FRONTEND_APPS]);
  });

  it("names unknown and repeated selections once, in first-seen order", () => {
    expect(unknownFrontendSelections(["vue", "vue3", "vue", "h5", "vue3"])).toEqual(["vue", "h5"]);
    expect(duplicateFrontendSelections(["vue3", "vue3", "h5-tech", "h5-tech"])).toEqual([
      "vue3",
      "h5-tech",
    ]);
    expect(duplicateFrontendSelections(["vue3", "react", "svelte"])).toEqual([]);
  });

  it("resolves page sets and one app, each in canonical order", () => {
    expect(resolveFrontendSelection(["h5-tech", "h5-minimal"])).toEqual({
      pages: ["h5-minimal", "h5-tech"],
    });
    expect(resolveFrontendSelection(["vue3"])).toEqual({ pages: [], app: "vue3" });
    expect(selectedFrontendApps(["svelte", "vue3", "h5-tech"])).toEqual(["vue3", "svelte"]);
    expect(resolveFrontendSelection([])).toEqual({ pages: [] });
    // The manifest, the result, and the render input all take this one ordering,
    // so a caller cannot record a selection in a different order than it writes.
    expect(frontendSelectionNames(resolveFrontendSelection(["h5-tech", "vue3"]))).toEqual([
      "h5-tech",
      "vue3",
    ]);
    expect(frontendSelectionNames(resolveFrontendSelection([]))).toEqual([]);
  });
});
