import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseTemplateRegistryIndex } from "./templateRegistry.js";

const GENERATED_INDEX = new URL(
  "../../tests/support/fixtures/registry-index.generated.json",
  import.meta.url,
);

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const versionEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: "1.0.0",
  path: "packages/acme-dashboard/1.0.0",
  digest: digest("a"),
  name: "Acme dashboard",
  description: "A dashboard service",
  category: "fullstack",
  framework: "h5",
  tags: ["dashboard"],
  requires: { uvp: ">=0.3.0", features: ["websocket"] },
  license: { spdx: "MIT", file: "LICENSE" },
  provenance: { author: "Acme", createdAt: "2026-10-18T00:00:00Z" },
  files: [{ path: "src/main.cc", digest: digest("b"), bytes: 10 }],
  ...overrides,
});

const index = (packages: readonly unknown[]): Record<string, unknown> => ({
  schema: "uvp.registry/1",
  packages,
});

const packageEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "acme-dashboard",
  latest: "1.0.0",
  versions: [versionEntry()],
  ...overrides,
});

const problemsOf = (value: unknown): readonly string[] => {
  const result = parseTemplateRegistryIndex(value);
  return result.ok
    ? []
    : result.problems.map((problem) => `${problem.location}: ${problem.message}`);
};

describe("parsing a uvp.registry/1 index", () => {
  it("accepts the bootstrap registry's empty index", () => {
    const result = parseTemplateRegistryIndex(index([]));
    expect(result).toEqual({
      ok: true,
      index: { schema: "uvp.registry/1", packages: [] },
    });
  });

  it("accepts an entry that repeats the manifest it mirrors", () => {
    const result = parseTemplateRegistryIndex(index([packageEntry()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.index.packages[0]?.versions[0];
    expect(entry).toMatchObject({
      version: "1.0.0",
      path: "packages/acme-dashboard/1.0.0",
      digest: digest("a"),
      name: "Acme dashboard",
      category: "fullstack",
      framework: "h5",
      tags: ["dashboard"],
    });
    expect(entry?.files).toHaveLength(1);
  });

  it("carries a mirrored routes declaration through the manifest rules", () => {
    // The generator spreads `template.json`, so a package that declares routes
    // puts them on every index entry. Refusing the key would refuse the whole
    // index, not just the entry, because a key is closed at every level.
    const result = parseTemplateRegistryIndex(
      index([packageEntry({ versions: [versionEntry({ routes: ["GET /healthz"] })] })]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.packages[0]?.versions[0]?.routes).toEqual(["GET /healthz"]);
  });

  it("validates a mirrored routes declaration instead of only tolerating it", () => {
    // A malformed route is reported by the package rule, under the entry that
    // carried it: "tolerated" would let the registry describe a route the
    // package format refuses.
    const problems = problemsOf(
      index([packageEntry({ versions: [versionEntry({ routes: ["FOO /healthz"] })] })]),
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("routes.0: method must be one of");
  });
});

describe("the shape the registry's generator emits", () => {
  it("accepts the index its own generator produces", async () => {
    // Built by `scripts/lib/package.mjs`'s `buildIndex`/`renderIndex` in
    // Antruly/uvp-templates at commit a95b3e0; regenerate it with
    // `tests/support/generateRegistryIndexFixture.mjs`. The documented example
    // omits the manifest repeats and the observation `binary` flag, so only a
    // generated fixture can show what the reader must actually accept.
    const raw = JSON.parse(await readFile(GENERATED_INDEX, "utf8")) as {
      packages: { versions: { preview?: string; files: { binary?: boolean }[] }[] }[];
    };
    const rawEntry = raw.packages[0]?.versions[0];
    expect(rawEntry).toMatchObject({
      schema: "uvp.template/1",
      id: "acme-dashboard",
      preview: "preview.png",
    });
    expect(rawEntry?.files.map((file) => file.binary)).toEqual([true, false]);

    const result = parseTemplateRegistryIndex(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const version = result.index.packages[0]?.versions[0];
    expect(version).toMatchObject({
      version: "1.0.0",
      path: "packages/acme-dashboard/1.0.0",
      name: "Acme dashboard",
      category: "fullstack",
      framework: "h5",
      tags: ["dashboard"],
      requires: { uvp: ">=0.3.0", features: ["websocket"] },
      license: { spdx: "MIT", file: "LICENSE" },
      provenance: { author: "Acme", createdAt: "2026-10-18T00:00:00Z" },
    });
    expect(version?.files).toEqual([
      {
        path: "assets/logo.dat",
        digest: "sha256:54a5241688ab835cbc21bd12d6b62db1f87f71a6def707d2d2b730b87cddbed6",
        bytes: 4,
      },
      {
        path: "src/main.cc",
        digest: "sha256:8537b5a3084a70a71c58b4a01abf9ac0ebea717f6cf09bac14e62bb7fbfb6582",
        bytes: 52,
      },
    ]);
  });

  it("requires redundant generator repeats to agree with the index", () => {
    expect(
      problemsOf(index([packageEntry({ versions: [versionEntry({ id: "other" })] })])),
    ).toContain("packages[0].versions[0].id: must be 'acme-dashboard' when present");
    expect(
      problemsOf(index([packageEntry({ versions: [versionEntry({ schema: "uvp.template/2" })] })])),
    ).toContain("packages[0].versions[0].schema: must be 'uvp.template/1' when present");
  });

  it("checks the observation-only binary field and still refuses unknown file keys", () => {
    expect(
      problemsOf(
        index([
          packageEntry({
            versions: [
              versionEntry({
                files: [{ path: "src/main.cc", digest: digest("b"), bytes: 1, binary: "no" }],
              }),
            ],
          }),
        ]),
      ),
    ).toContain("packages[0].versions[0].files[0].binary: must be a boolean");
    expect(
      problemsOf(
        index([
          packageEntry({
            versions: [
              versionEntry({
                files: [{ path: "src/main.cc", digest: digest("b"), bytes: 1, symlink: true }],
              }),
            ],
          }),
        ]),
      ),
    ).toContain("packages[0].versions[0].files[0].symlink: is not a field of uvp.registry/1");
  });
});

describe("the index rules", () => {
  it("refuses a schema it does not implement", () => {
    expect(problemsOf({ schema: "uvp.registry/2", packages: [] })).toEqual([
      "schema: must be 'uvp.registry/1'",
    ]);
  });

  it("reports an unknown key at every level instead of ignoring it", () => {
    expect(problemsOf({ ...index([]), generatedAt: "now" })).toContain(
      "generatedAt: is not a field of uvp.registry/1",
    );
    expect(problemsOf(index([{ ...packageEntry(), downloads: 3 }]))).toContain(
      "packages[0].downloads: is not a field of uvp.registry/1",
    );
    expect(problemsOf(index([packageEntry({ versions: [versionEntry({ size: 1 })] })]))).toContain(
      "packages[0].versions[0].size: is not a field of uvp.registry/1",
    );
  });

  it("checks a version entry with the manifest rules it mirrors", () => {
    const problems = problemsOf(
      index([packageEntry({ versions: [versionEntry({ category: "service" })] })]),
    );
    expect(problems).toContain(
      "packages[0].versions[0].category: must be one of frontend, backend, fullstack, module",
    );
  });

  it("requires the package path to be exactly the immutable location", () => {
    const problems = problemsOf(
      index([
        packageEntry({
          versions: [versionEntry({ path: "packages/acme-dashboard/1.0.0/../1.0.0" })],
        }),
      ]),
    );
    expect(problems).toContain(
      "packages[0].versions[0].path: must be 'packages/acme-dashboard/1.0.0'",
    );
  });

  it("requires a sha256 digest and a manifest digest that looks like one", () => {
    expect(
      problemsOf(index([packageEntry({ versions: [versionEntry({ digest: "md5:abc" })] })])),
    ).toContain(
      "packages[0].versions[0].digest: must be 'sha256:' followed by 64 lowercase hex characters",
    );
    expect(
      problemsOf(
        index([
          packageEntry({
            versions: [
              versionEntry({ files: [{ path: "src/main.cc", digest: "sha256:xyz", bytes: 1 }] }),
            ],
          }),
        ]),
      ),
    ).toContain(
      "packages[0].versions[0].files[0].digest: must be 'sha256:' followed by 64 lowercase hex characters",
    );
  });

  it("requires versions to be unique and ascending, and latest to name one", () => {
    const problems = problemsOf(
      index([
        packageEntry({
          latest: "9.9.9",
          versions: [versionEntry(), versionEntry()],
        }),
      ]),
    );
    expect(problems).toContain("packages[0].versions[1].version: duplicates '1.0.0'");
    expect(problems).toContain(
      "packages[0].versions[1].version: must sort after the previous version (ascending SemVer precedence)",
    );
    expect(problems).toContain("packages[0].latest: must name one of the package's versions");
  });

  it("accepts prerelease ordering and rejects a descending list", () => {
    const entries = [
      versionEntry({ version: "1.0.0-alpha", path: "packages/acme-dashboard/1.0.0-alpha" }),
      versionEntry({ version: "1.0.0", path: "packages/acme-dashboard/1.0.0" }),
    ];
    const ok = parseTemplateRegistryIndex(
      index([packageEntry({ latest: "1.0.0", versions: entries })]),
    );
    expect(ok.ok).toBe(true);
    const descending = problemsOf(
      index([packageEntry({ latest: "1.0.0", versions: [...entries].reverse() })]),
    );
    expect(descending).toContain(
      "packages[0].versions[1].version: must sort after the previous version (ascending SemVer precedence)",
    );
  });

  it("requires packages to be unique and sorted by id", () => {
    const problems = problemsOf(
      index([
        packageEntry({
          id: "zeta",
          versions: [versionEntry({ path: "packages/zeta/1.0.0" })],
        }),
        packageEntry({
          id: "alpha",
          versions: [versionEntry({ path: "packages/alpha/1.0.0" })],
        }),
      ]),
    );
    expect(problems).toContain("packages[1].id: must sort after the previous id (ascending)");
  });

  it("reports a package with no versions rather than accepting an empty entry", () => {
    expect(problemsOf(index([packageEntry({ versions: [] })]))).toContain(
      "packages[0].versions: must list at least one version",
    );
  });
});
