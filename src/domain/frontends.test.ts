import { describe, expect, it } from "vitest";

import {
  UVP_FRONTENDS,
  duplicateFrontends,
  isUvpFrontend,
  resolveFrontends,
  unknownFrontends,
} from "./frontends.js";

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
