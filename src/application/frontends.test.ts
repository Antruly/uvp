import { describe, expect, it } from "vitest";

import { UVP_FRONTENDS } from "../domain/frontends.js";
import { frontendDirectory, frontendFiles, frontendSelector } from "./frontends.js";

/**
 * What a generated skin contains, and what it can reach.
 *
 * The pages are the one generated artifact a browser interprets rather than a
 * compiler, so the facts worth testing are the ones a compiler would catch in
 * C++: that every file a page links exists beside it, that nothing names a
 * remote origin, and that the same selection produces the same bytes.
 */

const filesOf = (frontend: (typeof UVP_FRONTENDS)[number]): Map<string, string> =>
  new Map(frontendFiles(frontend, "svc").map((file) => [file.path, file.content]));

describe("the generated skins", () => {
  it.each(UVP_FRONTENDS)("%s writes three files under its own directory", (frontend) => {
    const files = filesOf(frontend);
    expect([...files.keys()]).toEqual([
      `${frontendDirectory(frontend)}/index.html`,
      `${frontendDirectory(frontend)}/app.css`,
      `${frontendDirectory(frontend)}/app.js`,
    ]);
  });

  it.each(UVP_FRONTENDS)("%s links only files beside it and names no remote origin", (frontend) => {
    const files = filesOf(frontend);
    const html = files.get(`${frontendDirectory(frontend)}/index.html`) ?? "";

    // A page whose stylesheet or script lived elsewhere would load over a CDN,
    // and the frontend would stop being offline-capable without the command
    // saying so. Both asset links are relative for the same reason.
    expect(html).toContain('href="app.css"');
    expect(html).toContain('src="app.js"');
    for (const content of files.values()) {
      expect(content).not.toMatch(/https?:\/\//u);
      expect(content).not.toMatch(/\/\/(?:cdn|unpkg|fonts|googleapis)/u);
    }
  });

  it.each(UVP_FRONTENDS)("%s is a responsive document, not a fragment", (frontend) => {
    const html = filesOf(frontend).get(`${frontendDirectory(frontend)}/index.html`) ?? "";
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain("<h1>svc</h1>");
    expect(html).toContain("<noscript>");
  });

  it.each(UVP_FRONTENDS)("%s renders the same bytes for the same name", (frontend) => {
    const first = frontendFiles(frontend, "svc");
    const second = frontendFiles(frontend, "svc");
    expect(second).toEqual(first);
  });

  it("gives the skins distinct styles", () => {
    const styles = UVP_FRONTENDS.map(
      (frontend) => filesOf(frontend).get(`${frontendDirectory(frontend)}/app.css`) ?? "",
    );
    expect(new Set(styles).size).toBe(UVP_FRONTENDS.length);
    // Light and dark skins both exist in the baseline set; a catalog that made
    // every choice look the same would not be a choice.
    expect(styles.some((style) => style.includes("color-scheme: light"))).toBe(true);
    expect(styles.some((style) => style.includes("color-scheme: dark"))).toBe(true);
  });
});

describe("the selector page", () => {
  it("links each skin at its own directory, relative to the page", () => {
    const html = frontendSelector(["h5-minimal", "h5-tech"], "svc");
    expect(html).toContain('<a href="./h5-minimal/">h5-minimal</a>');
    expect(html).toContain('<a href="./h5-tech/">h5-tech</a>');
    expect(html).toContain("2 static frontends");
    // One file: the selector carries its styles inline and no script, so it has
    // no asset a later edit could forget to copy.
    expect(html).toContain("<style>");
    expect(html).not.toContain("<script");
  });

  it("says one frontend in the singular", () => {
    expect(frontendSelector(["h5-dashboard"], "svc")).toContain("one static frontend");
  });

  it("says each page is local, because that is the promise the command makes", () => {
    const html = frontendSelector(["h5-tech"], "svc");
    expect(html).toContain("none of them loads a CDN");
    expect(html).not.toMatch(/https?:\/\//u);
  });
});
