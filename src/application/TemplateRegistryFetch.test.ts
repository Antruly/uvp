import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../domain/identity.js";

import {
  TemplateRegistryFetchError,
  fetchTemplateRegistryPackage,
  templateArchiveCachePath,
} from "./TemplateRegistryFetch.js";
import { TemplateRegistryError, type TemplateRegistryTransport } from "./TemplateRegistry.js";
import { listTemplatePackages } from "./TemplateStore.js";

import { makeTarGz } from "../../tests/support/templateArchiveFixture.js";

/**
 * The fetch increment against a fixture registry served through the injectable
 * transport. No test contacts a real registry. The interesting cases are the
 * failure directions: a corrupted archive must fail before extraction, a
 * corrupted file must leave no store entry, and an unavailable network must
 * fall back only to a digest-matching cache or report `undetermined`.
 */

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const temporaryRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const id = "acme-dashboard";
const version = "1.0.0";
const INDEX_URL = "https://registry.example/index.json";
const ARCHIVE_URL = `https://registry.example/archives/${id}/${version}.tgz`;
const content = "int main() { return 0; }\n";

const fileDigestOf = (value: string): string => `sha256:${sha256(value)}`;

interface FixtureOptions {
  /** The bytes actually placed in the archive's `files/src/main.cc`. */
  readonly archiveContent?: string;
  /** The content the manifest and the index's `files[]` declare. */
  readonly declaredContent?: string;
  readonly includeArchive?: boolean;
}

interface Fixture {
  readonly archive: Buffer;
  readonly index: Record<string, unknown>;
}

const makeFixture = (options: FixtureOptions = {}): Fixture => {
  const archivedContent = options.archiveContent ?? content;
  const declaredContent = options.declaredContent ?? content;
  const declaredFiles = [
    {
      path: "src/main.cc",
      digest: fileDigestOf(declaredContent),
      bytes: Buffer.byteLength(declaredContent),
    },
  ];
  const template = {
    schema: "uvp.template/1",
    id,
    version,
    name: "Acme dashboard",
    category: "fullstack",
    framework: "h5",
    files: declaredFiles,
    license: { spdx: "MIT", file: "LICENSE" },
    provenance: { author: "Acme", createdAt: "2026-10-18T00:00:00Z" },
  };
  const archive = makeTarGz([
    { path: "template.json", bytes: Buffer.from(JSON.stringify(template)) },
    { path: "README.md", bytes: Buffer.from("# Acme\n") },
    { path: "LICENSE", bytes: Buffer.from("MIT\n") },
    { path: "files/src/main.cc", bytes: Buffer.from(archivedContent), usePrefix: true },
  ]);
  const versionEntry: Record<string, unknown> = {
    version,
    path: `packages/${id}/${version}`,
    digest: `sha256:${sha256(canonicalJson(template))}`,
    ...(options.includeArchive === false
      ? {}
      : {
          archive: {
            path: `archives/${id}/${version}.tgz`,
            digest: `sha256:${sha256(archive)}`,
            bytes: archive.byteLength,
          },
        }),
    name: template.name,
    category: template.category,
    framework: template.framework,
    files: declaredFiles,
    license: template.license,
    provenance: template.provenance,
  };
  return {
    archive,
    index: {
      schema: "uvp.registry/1",
      packages: [{ id, latest: version, versions: [versionEntry] }],
    },
  };
};

interface TransportRoutes {
  readonly index: unknown;
  readonly archive?: Buffer;
  readonly indexUrl?: string;
  /** The URL the index answer reports after redirects; defaults to `indexUrl`. */
  readonly finalIndexUrl?: string;
  readonly archiveUrl?: string;
}

const transportFor = (routes: TransportRoutes): TemplateRegistryTransport => {
  const indexUrl = routes.indexUrl ?? INDEX_URL;
  const finalIndexUrl = routes.finalIndexUrl ?? indexUrl;
  const archiveUrl = routes.archiveUrl ?? ARCHIVE_URL;
  const indexBody = Buffer.from(JSON.stringify(routes.index));
  return async (request) => {
    if (request.url === indexUrl) {
      return { status: 200, body: indexBody, url: finalIndexUrl };
    }
    if (routes.archive !== undefined && request.url === archiveUrl) {
      return { status: 200, body: routes.archive, url: archiveUrl };
    }
    throw new TemplateRegistryError("unreachable", `no fixture route for ${request.url}`);
  };
};

const offline: TemplateRegistryTransport = async () => {
  throw new TemplateRegistryError("unreachable", "the registry is offline in this test");
};

const fetchFixture = async (options: {
  readonly fixture: Fixture;
  readonly cacheRoot: string;
  readonly storeRoot: string;
  readonly transport?: TemplateRegistryTransport;
  readonly offline?: boolean;
  readonly indexUrl?: string;
}): Promise<Awaited<ReturnType<typeof fetchTemplateRegistryPackage>>> => {
  const indexUrl = options.indexUrl ?? INDEX_URL;
  return fetchTemplateRegistryPackage({
    id,
    version,
    indexUrl,
    cacheRoot: options.cacheRoot,
    storeRoot: options.storeRoot,
    transport: options.transport ?? transportFor(options.fixture),
    ...(options.offline === undefined ? {} : { offline: options.offline }),
  });
};

describe("fetching a registry package", () => {
  it("downloads, verifies, caches, and imports the package", async () => {
    const cacheRoot = await temporaryRoot("uvp-fetch-cache-");
    const storeRoot = await temporaryRoot("uvp-fetch-store-");
    const fixture = makeFixture();

    const result = await fetchFixture({ fixture, cacheRoot, storeRoot });

    expect(result.state).toBe("network");
    if (result.state === "undetermined") return;
    expect(result.package.id).toBe(id);
    expect(result.package.version).toBe(version);
    expect(result.package.files).toEqual([
      {
        path: "src/main.cc",
        digest: fileDigestOf(content),
        bytes: Buffer.byteLength(content),
      },
    ]);

    const listed = await listTemplatePackages({ storeRoot });
    expect(listed.corrupt).toEqual([]);
    expect(listed.packages.map((entry) => `${entry.id}@${entry.version}`)).toEqual([
      `${id}@${version}`,
    ]);

    const cached = await readFile(templateArchiveCachePath(cacheRoot, id, version));
    expect(cached.equals(fixture.archive)).toBe(true);
  });
});

describe("the fetch's integrity failures", () => {
  it("fails on a corrupted archive digest before extraction or import", async () => {
    const cacheRoot = await temporaryRoot("uvp-fetch-cache-");
    const storeRoot = await temporaryRoot("uvp-fetch-store-");
    const fixture = makeFixture();
    // Same byte count, different bytes: the length check passes and the digest
    // is the only thing that can catch it.
    const corrupted = Buffer.from(fixture.archive);
    corrupted[corrupted.length - 20] = (corrupted[corrupted.length - 20] ?? 0) ^ 0xff;

    await expect(
      fetchFixture({
        fixture,
        cacheRoot,
        storeRoot,
        transport: transportFor({ index: fixture.index, archive: corrupted }),
      }),
    ).rejects.toMatchObject({
      name: "TemplateRegistryFetchError",
      code: "archive_digest",
      location: "archive.digest",
    });

    const listed = await listTemplatePackages({ storeRoot });
    expect(listed.packages).toEqual([]);
  });

  it("fails on a corrupted file digest and leaves no store entry", async () => {
    const cacheRoot = await temporaryRoot("uvp-fetch-cache-");
    const storeRoot = await temporaryRoot("uvp-fetch-store-");
    // The archive is internally consistent (its own digest matches), but the
    // content under files/src/main.cc is not what the index declares.
    const fixture = makeFixture({ archiveContent: "int main() { return 1; }\n" });

    let observed: unknown;
    try {
      await fetchFixture({ fixture, cacheRoot, storeRoot });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(TemplateRegistryFetchError);
    expect(observed).toMatchObject({
      code: "file_digest",
      location: "files[0].path",
    });

    const listed = await listTemplatePackages({ storeRoot });
    expect(listed.packages).toEqual([]);
    expect(listed.corrupt).toEqual([]);
  });
});

describe("the archive cache", () => {
  it("uses the cached archive after a successful fetch when offline", async () => {
    const cacheRoot = await temporaryRoot("uvp-fetch-cache-");
    const firstStore = await temporaryRoot("uvp-fetch-store-");
    const fixture = makeFixture();
    await fetchFixture({ fixture, cacheRoot, storeRoot: firstStore });

    const offlineStore = await temporaryRoot("uvp-fetch-store-");
    const result = await fetchFixture({
      fixture,
      cacheRoot,
      storeRoot: offlineStore,
      transport: offline,
      offline: true,
    });

    expect(result.state).toBe("cache");
    if (result.state === "undetermined") return;
    expect(result.package.id).toBe(id);
    expect(result.staleReason).toBeUndefined();

    const listed = await listTemplatePackages({ storeRoot: offlineStore });
    expect(listed.corrupt).toEqual([]);
    expect(listed.packages.map((entry) => `${entry.id}@${entry.version}`)).toEqual([
      `${id}@${version}`,
    ]);
  });

  it("falls back to a digest-matching cached archive when the download fails", async () => {
    const cacheRoot = await temporaryRoot("uvp-fetch-cache-");
    const firstStore = await temporaryRoot("uvp-fetch-store-");
    const fixture = makeFixture();
    await fetchFixture({ fixture, cacheRoot, storeRoot: firstStore });

    // The index is still served; only the archive host is unreachable.
    const fallbackStore = await temporaryRoot("uvp-fetch-store-");
    const result = await fetchFixture({
      fixture,
      cacheRoot,
      storeRoot: fallbackStore,
      transport: transportFor({ index: fixture.index }),
    });

    expect(result.state).toBe("cache");
    if (result.state === "undetermined") return;
    expect(result.staleReason).toContain("archive download failed");
    expect(result.package.id).toBe(id);
    const listed = await listTemplatePackages({ storeRoot: fallbackStore });
    expect(listed.packages.map((entry) => `${entry.id}@${entry.version}`)).toEqual([
      `${id}@${version}`,
    ]);
  });

  it("does not use a cached archive whose digest does not match the index", async () => {
    const cacheRoot = await temporaryRoot("uvp-fetch-cache-");
    const firstStore = await temporaryRoot("uvp-fetch-store-");
    const fixture = makeFixture();
    await fetchFixture({ fixture, cacheRoot, storeRoot: firstStore });

    const cachePath = templateArchiveCachePath(cacheRoot, id, version);
    const original = await readFile(cachePath);
    // Same length, different bytes: only the digest can reject it.
    await writeFile(cachePath, Buffer.alloc(original.byteLength, 0));

    const result = await fetchFixture({
      fixture,
      cacheRoot,
      storeRoot: await temporaryRoot("uvp-fetch-store-"),
      transport: transportFor({ index: fixture.index }),
    });

    expect(result.state).toBe("undetermined");
    if (result.state !== "undetermined") return;
    expect(result.details.some((detail) => detail.includes("digest"))).toBe(true);
  });

  it("reports undetermined when offline and no cached archive exists", async () => {
    const cacheRoot = await temporaryRoot("uvp-fetch-cache-");
    const warmedStore = await temporaryRoot("uvp-fetch-store-");
    const fixture = makeFixture();
    await fetchFixture({ fixture, cacheRoot, storeRoot: warmedStore });

    // The index cache is still there; only the archive is missing.
    await rm(path.join(cacheRoot, "archives"), { recursive: true, force: true });

    const result = await fetchFixture({
      fixture,
      cacheRoot,
      storeRoot: await temporaryRoot("uvp-fetch-store-"),
      transport: offline,
      offline: true,
    });

    expect(result.state).toBe("undetermined");
    if (result.state !== "undetermined") return;
    expect(result.details.some((detail) => detail.includes("no cached archive"))).toBe(true);

    const emptyCache = await temporaryRoot("uvp-fetch-cache-");
    const cold = await fetchFixture({
      fixture,
      cacheRoot: emptyCache,
      storeRoot: await temporaryRoot("uvp-fetch-store-"),
      transport: offline,
      offline: true,
    });
    expect(cold.state).toBe("undetermined");
  });
});

describe("index coverage and archive URL resolution", () => {
  it("names a missing archive entry instead of reporting no package", async () => {
    const cacheRoot = await temporaryRoot("uvp-fetch-cache-");
    const storeRoot = await temporaryRoot("uvp-fetch-store-");
    const fixture = makeFixture({ includeArchive: false });

    await expect(fetchFixture({ fixture, cacheRoot, storeRoot })).rejects.toMatchObject({
      name: "TemplateRegistryFetchError",
      code: "archive_missing",
    });
  });

  it("resolves the archive path against the index's final URL", async () => {
    const cacheRoot = await temporaryRoot("uvp-fetch-cache-");
    const storeRoot = await temporaryRoot("uvp-fetch-store-");
    const fixture = makeFixture();
    const requested = "https://registry.example/redirect";
    const finalIndex = "https://registry.example/registry/index.json";
    const finalArchive = `https://registry.example/registry/archives/${id}/${version}.tgz`;

    const result = await fetchFixture({
      fixture,
      cacheRoot,
      storeRoot,
      indexUrl: requested,
      transport: transportFor({
        index: fixture.index,
        archive: fixture.archive,
        indexUrl: requested,
        finalIndexUrl: finalIndex,
        archiveUrl: finalArchive,
      }),
    });

    expect(result.state).toBe("network");
    if (result.state === "undetermined") return;
    expect(result.package.id).toBe(id);
  });
});
