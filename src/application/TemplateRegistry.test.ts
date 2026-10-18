import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseTemplateRegistryIndex } from "../domain/templateRegistry.js";
import {
  TemplateRegistryError,
  readTemplateRegistryIndex,
  searchRegistryIndex,
  searchTemplateRegistry,
  type TemplateRegistryTransport,
} from "./TemplateRegistry.js";

/**
 * The registry read side: a fixture HTTP server exercises the default
 * transport, and an injected failing transport isolates the cache and
 * unavailable paths. No test contacts a real registry.
 */

const roots: string[] = [];
const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "uvp-registry-"));
  roots.push(root);
  return root;
};

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const versionEntry = (id: string, version: string, overrides: Record<string, unknown> = {}) => ({
  version,
  path: `packages/${id}/${version}`,
  digest: digest("a"),
  name: `${id} ${version}`,
  description: `${id} description`,
  category: "fullstack",
  framework: "h5",
  tags: ["dashboard"],
  license: { spdx: "MIT", file: "LICENSE" },
  provenance: { author: "Acme", createdAt: "2026-10-18T00:00:00Z" },
  files: [{ path: "src/main.cc", digest: digest("b"), bytes: 10 }],
  ...overrides,
});

const fixtureIndex = (packages: readonly unknown[] = []): Record<string, unknown> => ({
  schema: "uvp.registry/1",
  packages,
});

const fixturePackage = (
  id: string,
  versions: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  latest: versions[versions.length - 1] ?? "1.0.0",
  versions: versions.map((version) => versionEntry(id, version)),
  ...overrides,
});

const serve = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  });
  return `http://127.0.0.1:${port}`;
};

const serveIndex = async (index: unknown): Promise<string> => {
  const body = JSON.stringify(index);
  return serve((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
};

const offline: TemplateRegistryTransport = async () => {
  throw new TemplateRegistryError("unreachable", "the registry is offline in this test");
};

describe("reading the registry index", () => {
  it("reads a valid index from the network and caches it", async () => {
    const cacheRoot = await temporaryRoot();
    const base = await serveIndex(fixtureIndex([fixturePackage("acme-dashboard", ["1.0.0"])]));

    const result = await readTemplateRegistryIndex({
      indexUrl: `${base}/index.json`,
      cacheRoot,
    });

    expect(result.state).toBe("read");
    if (result.state !== "read") return;
    expect(result.source).toBe("network");
    expect(result.index.packages.map((entry) => entry.id)).toEqual(["acme-dashboard"]);
    const cached = JSON.parse(await readFile(path.join(cacheRoot, "index.json"), "utf8"));
    expect(cached.schema).toBe("uvp.registry/1");
  });

  it("reports the cached index, naming the network failure, when the registry cannot be reached", async () => {
    const cacheRoot = await temporaryRoot();
    const base = await serveIndex(fixtureIndex([fixturePackage("acme-dashboard", ["1.0.0"])]));
    await readTemplateRegistryIndex({ indexUrl: `${base}/index.json`, cacheRoot });

    const result = await readTemplateRegistryIndex({
      indexUrl: `${base}/index.json`,
      cacheRoot,
      transport: offline,
    });

    expect(result.state).toBe("read");
    if (result.state !== "read") return;
    expect(result.source).toBe("cache");
    expect(result.staleReason).toContain("offline");
    expect(result.index.packages).toHaveLength(1);
  });

  it("reports undetermined, not an empty registry, when neither the network nor a cache answers", async () => {
    const cacheRoot = await temporaryRoot();

    const result = await readTemplateRegistryIndex({
      indexUrl: "https://registry.invalid/index.json",
      cacheRoot,
      transport: offline,
    });

    expect(result.state).toBe("undetermined");
    if (result.state !== "undetermined") return;
    expect(result.reason).toContain("offline");
    expect(result.details.some((detail) => detail.includes("no cached index"))).toBe(true);
  });

  it("serves an offline read from the cache without calling it stale", async () => {
    const cacheRoot = await temporaryRoot();
    const base = await serveIndex(fixtureIndex([]));
    await readTemplateRegistryIndex({ indexUrl: `${base}/index.json`, cacheRoot });

    const result = await readTemplateRegistryIndex({ cacheRoot, offline: true });

    expect(result.state).toBe("read");
    if (result.state !== "read") return;
    expect(result.source).toBe("cache");
    expect(result.staleReason).toBeUndefined();
  });

  it("reports undetermined when offline and no cache exists", async () => {
    const cacheRoot = await temporaryRoot();
    const result = await readTemplateRegistryIndex({ cacheRoot, offline: true });
    expect(result.state).toBe("undetermined");
    if (result.state !== "undetermined") return;
    expect(result.reason).toContain("offline");
  });

  it("refuses a response larger than the byte cap instead of parsing a truncated index", async () => {
    const cacheRoot = await temporaryRoot();
    const base = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(fixtureIndex([])).padEnd(4096, " "));
    });

    const result = await readTemplateRegistryIndex({
      indexUrl: `${base}/index.json`,
      cacheRoot,
      maxBytes: 64,
    });

    expect(result.state).toBe("undetermined");
    if (result.state !== "undetermined") return;
    expect(result.reason).toContain("larger than 64 bytes");
  });

  it("reports a body that is not JSON as invalid rather than empty", async () => {
    const cacheRoot = await temporaryRoot();
    const base = await serve((_request, response) => {
      response.writeHead(200);
      response.end("not json");
    });

    const result = await readTemplateRegistryIndex({ indexUrl: `${base}/index.json`, cacheRoot });

    expect(result.state).toBe("undetermined");
    if (result.state !== "undetermined") return;
    expect(result.reason).toContain("not JSON");
  });

  it("reports JSON that is not a uvp.registry/1 index as invalid", async () => {
    const cacheRoot = await temporaryRoot();
    const base = await serveIndex({ schema: "uvp.registry/2", packages: [] });

    const result = await readTemplateRegistryIndex({ indexUrl: `${base}/index.json`, cacheRoot });

    expect(result.state).toBe("undetermined");
    if (result.state !== "undetermined") return;
    expect(result.reason).toContain("not a valid uvp.registry/1 index");
    expect(result.details).toContain("schema: must be 'uvp.registry/1'");
  });

  it("follows a redirect to the index", async () => {
    const cacheRoot = await temporaryRoot();
    const body = JSON.stringify(fixtureIndex([fixturePackage("acme-dashboard", ["1.0.0"])]));
    const base = await serve((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/index.json" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });

    const result = await readTemplateRegistryIndex({
      indexUrl: `${base}/redirect`,
      cacheRoot,
    });

    expect(result.state).toBe("read");
    if (result.state !== "read") return;
    expect(result.source).toBe("network");
  });

  it("does not trust a cached index that no longer parses", async () => {
    const cacheRoot = await temporaryRoot();
    const base = await serveIndex(fixtureIndex([]));
    await readTemplateRegistryIndex({ indexUrl: `${base}/index.json`, cacheRoot });
    await writeFile(
      path.join(cacheRoot, "index.json"),
      '{"schema":"uvp.registry/1","packages":{}}',
    );

    const result = await readTemplateRegistryIndex({ cacheRoot, transport: offline });

    expect(result.state).toBe("undetermined");
    if (result.state !== "undetermined") return;
    expect(
      result.details.some((detail) => detail.includes("not a valid uvp.registry/1 index")),
    ).toBe(true);

    await writeFile(path.join(cacheRoot, "index.json"), "not json");
    const again = await readTemplateRegistryIndex({ cacheRoot, transport: offline });
    expect(again.state).toBe("undetermined");
    if (again.state !== "undetermined") return;
    expect(again.details.some((detail) => detail.includes("could not be parsed"))).toBe(true);
  });
});

const searchableIndex = {
  schema: "uvp.registry/1",
  packages: [
    {
      id: "acme-dashboard",
      latest: "1.1.0",
      versions: [versionEntry("acme-dashboard", "1.0.0"), versionEntry("acme-dashboard", "1.1.0")],
    },
    {
      id: "beta-api",
      latest: "2.0.0",
      versions: [
        versionEntry("beta-api", "2.0.0", {
          category: "backend",
          framework: undefined,
          tags: ["api"],
          name: "Beta API",
          description: "A backend API",
        }),
      ],
    },
  ],
} as const;

const parsedSearchable = (): Parameters<typeof searchRegistryIndex>[0] => {
  // The fixture passes through the parser, so the test cannot drift from the format.
  const parsed = parseTemplateRegistryIndex(searchableIndex);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  return parsed.index;
};

describe("searching a registry index", () => {
  it("returns the latest version of each package by default", () => {
    const page = searchRegistryIndex(parsedSearchable(), {});
    expect(page.matches.map((match) => `${match.id}@${match.version}`)).toEqual([
      "acme-dashboard@1.1.0",
      "beta-api@2.0.0",
    ]);
    expect(page.total).toBe(2);
    expect(page.truncated).toBe(false);
  });

  it("returns every version when asked", () => {
    const page = searchRegistryIndex(parsedSearchable(), { allVersions: true });
    expect(page.matches.map((match) => `${match.id}@${match.version}`)).toEqual([
      "acme-dashboard@1.1.0",
      "acme-dashboard@1.0.0",
      "beta-api@2.0.0",
    ]);
  });

  it("filters by category, framework, tags, and free text", () => {
    expect(
      searchRegistryIndex(parsedSearchable(), { category: "backend" }).matches.map((m) => m.id),
    ).toEqual(["beta-api"]);
    expect(
      searchRegistryIndex(parsedSearchable(), { framework: "h5" }).matches.map((m) => m.id),
    ).toEqual(["acme-dashboard"]);
    expect(
      searchRegistryIndex(parsedSearchable(), { tags: ["dashboard"] }).matches.map((m) => m.id),
    ).toEqual(["acme-dashboard"]);
    expect(
      searchRegistryIndex(parsedSearchable(), { text: "backend" }).matches.map((m) => m.id),
    ).toEqual(["beta-api"]);
  });

  it("returns that exact version across ids when a version is pinned", () => {
    const page = searchRegistryIndex(parsedSearchable(), { version: "1.0.0" });
    expect(page.matches).toHaveLength(1);
    expect(page.matches[0]).toMatchObject({
      id: "acme-dashboard",
      version: "1.0.0",
      latest: "1.1.0",
      path: "packages/acme-dashboard/1.0.0",
    });
    expect(page.matches[0]?.file_count).toBe(1);
  });

  it("pages without hiding that more matches exist", () => {
    const page = searchRegistryIndex(parsedSearchable(), {
      allVersions: true,
      limit: 1,
      offset: 1,
    });
    expect(page.matches).toHaveLength(1);
    expect(page.total).toBe(3);
    expect(page.truncated).toBe(true);
    expect(page.offset).toBe(1);
    expect(page.limit).toBe(1);
  });

  it("says what matched, so the order is explainable", () => {
    const page = searchRegistryIndex(parsedSearchable(), {
      category: "backend",
      tags: ["api"],
      text: "beta",
    });
    expect(page.matches[0]?.matched_on).toEqual(["category", "tag:api", "text:beta"]);
    expect(page.matches[0]?.score).toBeGreaterThan(0);
  });
});

describe("the composed search", () => {
  it("returns undetermined rather than an empty page when the registry is unavailable", async () => {
    const cacheRoot = await temporaryRoot();

    const result = await searchTemplateRegistry(
      { text: "dashboard" },
      { cacheRoot, transport: offline },
    );

    expect(result.state).toBe("undetermined");
    expect("matches" in result).toBe(false);
    if (result.state !== "undetermined") return;
    expect(result.reason).toContain("offline");
  });

  it("searches a cached index when the network read fails", async () => {
    const cacheRoot = await temporaryRoot();
    const base = await serveIndex(fixtureIndex([fixturePackage("acme-dashboard", ["1.0.0"])]));
    await readTemplateRegistryIndex({ indexUrl: `${base}/index.json`, cacheRoot });

    const result = await searchTemplateRegistry(
      { text: "acme" },
      { cacheRoot, transport: offline },
    );

    expect(result.state).toBe("read");
    if (result.state !== "read") return;
    expect(result.source).toBe("cache");
    expect(result.staleReason).toContain("offline");
    expect(result.matches.map((match) => match.id)).toEqual(["acme-dashboard"]);
  });
});
