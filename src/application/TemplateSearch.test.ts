import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { importTemplatePackage } from "./TemplateStore.js";
import { compareTemplateVersions, searchTemplatePackages } from "./TemplateSearch.js";
import { makeTemplatePackage } from "../../tests/support/templatePackageFixture.js";

/**
 * Search is what an external AI reads before it chooses a template. The tests
 * therefore hold two claims at once: the filters select the packages a caller
 * asked for, and the result carries enough metadata to choose without fetching
 * file bytes. The ranking is deterministic and documented; there is no model
 * and no "best" claim.
 */

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const temporaryRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
};

const makeStore = async (): Promise<string> =>
  path.join(await temporaryRoot("uvp-search-store-"), "store");

const importPackage = async (
  storeRoot: string,
  overrides: Record<string, unknown>,
): Promise<void> => {
  const root = await temporaryRoot("uvp-search-source-");
  const fixture = await makeTemplatePackage({ root, overrides });
  await importTemplatePackage({ sourceDir: fixture.dir, storeRoot });
};

const dashboard = {
  id: "acme-dashboard",
  version: "1.2.0",
  name: "Acme dashboard",
  description: "A dashboard for service metrics.",
  category: "fullstack",
  framework: "h5",
  tags: ["tech", "dark"],
  requires: { features: ["websocket"] },
};

const dashboardNext = {
  ...dashboard,
  version: "1.3.0",
  description: "A dashboard for service metrics, newer.",
};

const blog = {
  id: "acme-blog",
  version: "0.9.0",
  name: "Acme blog",
  description: "A minimal blog.",
  category: "frontend",
  framework: "vue3",
  tags: ["minimal"],
  requires: { features: ["websocket", "tls"] },
};

const api = {
  id: "acme-api",
  version: "2.0.0",
  name: "Acme API",
  description: "A REST API.",
  category: "backend",
  tags: ["tech"],
};

const populatedStore = async (): Promise<string> => {
  const storeRoot = await makeStore();
  await importPackage(storeRoot, dashboard);
  await importPackage(storeRoot, dashboardNext);
  await importPackage(storeRoot, blog);
  await importPackage(storeRoot, api);
  return storeRoot;
};

describe("version ordering", () => {
  it("orders numerically, not as strings, and puts a prerelease below its release", () => {
    expect(compareTemplateVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareTemplateVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareTemplateVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareTemplateVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("searching the local store", () => {
  it("returns the latest version of each id by default, with metadata and no file bytes", async () => {
    const storeRoot = await populatedStore();
    const result = await searchTemplatePackages({}, { storeRoot });

    expect(result.total).toBe(3);
    expect(result.matches.map((match) => match.id)).toEqual([
      "acme-api",
      "acme-blog",
      "acme-dashboard",
    ]);
    const dashboardMatch = result.matches.find((match) => match.id === "acme-dashboard");
    expect(dashboardMatch?.version).toBe("1.3.0");
    expect(dashboardMatch?.file_count).toBe(1);
    expect(dashboardMatch === undefined ? undefined : "files" in dashboardMatch).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.corrupt).toEqual([]);
  });

  it("returns every version when asked, and pins one version when asked", async () => {
    const storeRoot = await populatedStore();
    const all = await searchTemplatePackages({ allVersions: true }, { storeRoot });
    expect(all.total).toBe(4);
    expect(
      all.matches
        .filter((match) => match.id === "acme-dashboard")
        .map((match) => match.version)
        .sort(),
    ).toEqual(["1.2.0", "1.3.0"]);

    const pinned = await searchTemplatePackages({ version: "1.2.0" }, { storeRoot });
    expect(pinned.total).toBe(1);
    expect(pinned.matches[0]?.id).toBe("acme-dashboard");
  });

  it("filters tags with all and any, and records what matched", async () => {
    const storeRoot = await populatedStore();
    const all = await searchTemplatePackages({ tags: ["tech", "dark"] }, { storeRoot });
    expect(all.matches.map((match) => match.id)).toEqual(["acme-dashboard"]);
    expect(all.matches[0]?.matched_on).toEqual(expect.arrayContaining(["tag:tech", "tag:dark"]));

    const any = await searchTemplatePackages({ tags: ["tech"], tagMode: "any" }, { storeRoot });
    expect(any.matches.map((match) => match.id)).toEqual(["acme-api", "acme-dashboard"]);
  });

  it("filters category, framework, and required features", async () => {
    const storeRoot = await populatedStore();
    expect(
      (await searchTemplatePackages({ category: "frontend" }, { storeRoot })).matches.map(
        (match) => match.id,
      ),
    ).toEqual(["acme-blog"]);
    expect(
      (await searchTemplatePackages({ framework: "vue3" }, { storeRoot })).matches.map(
        (match) => match.id,
      ),
    ).toEqual(["acme-blog"]);
    expect(
      (await searchTemplatePackages({ features: ["websocket"] }, { storeRoot })).matches.map(
        (match) => match.id,
      ),
    ).toEqual(["acme-blog", "acme-dashboard"]);
  });

  it("searches free text over metadata and reports the token that matched", async () => {
    const storeRoot = await populatedStore();
    const result = await searchTemplatePackages({ text: "dashboard" }, { storeRoot });
    expect(result.matches.map((match) => match.id)).toEqual(["acme-dashboard"]);
    expect(result.matches[0]?.matched_on).toEqual(expect.arrayContaining(["text:dashboard"]));

    const absent = await searchTemplatePackages({ text: "absent" }, { storeRoot });
    expect(absent.total).toBe(0);
    expect(absent.matches).toEqual([]);
  });

  it("pages deterministically and reports truncation", async () => {
    const storeRoot = await populatedStore();
    const first = await searchTemplatePackages({ limit: 2 }, { storeRoot });
    expect(first.matches).toHaveLength(2);
    expect(first.total).toBe(3);
    expect(first.truncated).toBe(true);

    const second = await searchTemplatePackages({ limit: 2, offset: 2 }, { storeRoot });
    expect(second.matches).toHaveLength(1);
    expect(second.truncated).toBe(false);
  });

  it("reports corrupt entries separately and never as matches", async () => {
    const storeRoot = await populatedStore();
    const broken = path.join(storeRoot, "broken", "1.0.0");
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, "template.json"), "{ not json\n");
    await writeFile(path.join(broken, "README.md"), "# Broken\n");

    const result = await searchTemplatePackages({}, { storeRoot });
    expect(result.matches).toHaveLength(3);
    expect(result.corrupt).toHaveLength(1);
    expect(result.corrupt[0]?.path).toBe(broken);
  });

  it("returns an empty result when the store does not exist", async () => {
    const storeRoot = path.join(await temporaryRoot("uvp-search-empty-"), "missing");
    const result = await searchTemplatePackages({ text: "anything" }, { storeRoot });
    expect(result).toEqual({
      matches: [],
      total: 0,
      offset: 0,
      limit: 20,
      truncated: false,
      corrupt: [],
    });
  });
});
