import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEMPLATE_PACKAGE_LIMITS,
  TEMPLATE_PACKAGE_CATEGORIES,
  TEMPLATE_PACKAGE_FRAMEWORKS,
  TEMPLATE_PACKAGE_SCHEMA,
  parseTemplatePackageVersion,
  templatePackageDigest,
  templatePackagePathProblem,
  templateVersionRequirementProblem,
  type TemplatePackageFileObservation,
  type TemplatePackageLimits,
  type TemplatePackageValidation,
} from "./templatePackage.js";
import { validateTemplatePackage } from "./templatePackageManifest.js";

/**
 * The `uvp.template/1` manifest is the package's identity claim, and every
 * problem a reader could find in it is a problem the store would otherwise
 * discover after writing something. These tests hold the validator to that:
 * the closed vocabulary, the path rules, the two-way file agreement, and the
 * distinction between "the reader checked and it is fine" and "the reader did
 * not check".
 */

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

type ManifestRecord = Record<string, unknown>;

const manifest = (overrides: ManifestRecord = {}): ManifestRecord => ({
  schema: TEMPLATE_PACKAGE_SCHEMA,
  id: "acme-dashboard",
  version: "1.2.0",
  name: "Acme dashboard",
  category: "fullstack",
  files: [{ path: "src/main.cc", digest: DIGEST_A, bytes: 120 }],
  license: { spdx: "MIT", file: "LICENSE" },
  provenance: { author: "Acme", createdAt: "2026-10-18T00:00:00Z" },
  ...overrides,
});

const check = (
  overrides: ManifestRecord = {},
  observations?: readonly TemplatePackageFileObservation[],
  limits?: TemplatePackageLimits,
): TemplatePackageValidation =>
  validateTemplatePackage({
    manifest: manifest(overrides),
    ...(observations === undefined ? {} : { files: observations }),
    ...(limits === undefined ? {} : { limits }),
  });

const problems = (result: TemplatePackageValidation): readonly string[] =>
  result.ok ? [] : result.problems.map((problem) => `${problem.location}: ${problem.message}`);

const rejects = (result: TemplatePackageValidation, location: string, message?: RegExp): void => {
  expect(result.ok).toBe(false);
  const matched = problems(result).filter((problem) => problem.startsWith(`${location}:`));
  expect(
    matched.length,
    `${location} was not reported; got ${problems(result).join(" | ")}`,
  ).toBeGreaterThan(0);
  if (message !== undefined) {
    expect(matched.some((problem) => message.test(problem))).toBe(true);
  }
};

describe("a valid package", () => {
  it("accepts the minimal manifest and returns it with its canonical digest", () => {
    const result = check();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problems).toEqual([]);
    expect(result.manifest.id).toBe("acme-dashboard");
    expect(result.manifest.version).toBe("1.2.0");
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.digest).toBe(templatePackageDigest(result.manifest));
  });

  it("records that a declaration-only result did not examine the tree", () => {
    const result = check();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The manifest is well-formed; nothing here says the tree matches it.
    expect(result.filesObserved).toBe(false);
  });

  it("keeps the optional fields it was given, and omits the ones it was not", () => {
    const result = check({
      description: "A dashboard",
      framework: "vue3",
      tags: ["dashboard", "admin"],
      requires: { uvp: ">=0.3.0", libuvcpp: ">=1.7.0 <2.0.0", features: ["tls"] },
      variables: {
        name: { type: "slug", default: "acme-dashboard" },
        port: { type: "port", default: 8080 },
      },
      preview: "preview.svg",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.framework).toBe("vue3");
    expect(result.manifest.tags).toEqual(["dashboard", "admin"]);
    expect(result.manifest.requires?.features).toEqual(["tls"]);
    expect(result.manifest.variables?.["port"]?.default).toBe(8080);
    expect(result.manifest.preview).toBe("preview.svg");
  });

  it("omits absent optionals rather than writing undefined or empty values", () => {
    const result = check();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of ["description", "framework", "tags", "requires", "variables", "preview"]) {
      expect(result.manifest).not.toHaveProperty(key);
    }
  });

  it("digests the manifest independently of its key order", () => {
    const first = validateTemplatePackage({ manifest: manifest() });
    const reordered = validateTemplatePackage({
      manifest: {
        provenance: { createdAt: "2026-10-18T00:00:00Z", author: "Acme" },
        license: { file: "LICENSE", spdx: "MIT" },
        files: [{ bytes: 120, digest: DIGEST_A, path: "src/main.cc" }],
        category: "fullstack",
        name: "Acme dashboard",
        version: "1.2.0",
        id: "acme-dashboard",
        schema: TEMPLATE_PACKAGE_SCHEMA,
      },
    });
    expect(first.ok && reordered.ok).toBe(true);
    if (!first.ok || !reordered.ok) return;
    expect(first.digest).toBe(reordered.digest);
  });

  it("changes the digest when the content changes", () => {
    const first = check();
    const renamed = check({ name: "Acme console" });
    expect(first.ok && renamed.ok).toBe(true);
    if (!first.ok || !renamed.ok) return;
    expect(first.digest).not.toBe(renamed.digest);
  });

  it("refuses a value that is not an object instead of guessing", () => {
    expect(problems(validateTemplatePackage({ manifest: null }))).toEqual([
      "manifest: must be an object",
    ]);
    expect(validateTemplatePackage({ manifest: [] }).ok).toBe(false);
  });
});

describe("the closed schema", () => {
  it("refuses an unknown top-level key, so a misspelling cannot be dropped silently", () => {
    const result = check({ licence: { spdx: "MIT" } });
    rejects(result, "licence", /not a field/u);
  });

  it("refuses unknown keys inside license, provenance, requires, variables, and files", () => {
    const result = check({
      license: { spdx: "MIT", file: "LICENSE", url: "https://example.test" },
      provenance: {
        author: "Acme",
        createdAt: "2026-10-18T00:00:00Z",
        email: "a@example.test",
      },
      requires: { features: [], checked: true },
      variables: { name: { type: "slug", required: true, pattern: "x" } },
      files: [{ path: "a.cc", digest: DIGEST_A, bytes: 1, mode: 420 }],
    });
    rejects(result, "license.url");
    rejects(result, "provenance.email");
    rejects(result, "requires.checked");
    rejects(result, "variables.name.pattern");
    rejects(result, "files[0].mode");
  });

  it("reports every problem, not only the first", () => {
    const result = check({ id: "Acme", version: "1.0", category: "desktop" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("identity", () => {
  it.each([
    ["a lowercase hyphenated slug", "acme-dashboard", true],
    ["an uppercase letter", "Acme", false],
    ["an underscore", "acme_dashboard", false],
    ["a leading hyphen", "-acme", false],
    ["a trailing hyphen", "acme-", false],
    ["an empty string", "", false],
    ["a dot", "acme.dashboard", false],
  ])("%s", (_label, id, accepted) => {
    expect(check({ id }).ok).toBe(accepted);
  });

  it("bounds the id length", () => {
    const limit = DEFAULT_TEMPLATE_PACKAGE_LIMITS.maxIdLength;
    expect(check({ id: "a".repeat(limit) }).ok).toBe(true);
    expect(check({ id: "a".repeat(limit + 1) }).ok).toBe(false);
  });

  it.each(["1.2.0", "0.0.0", "10.20.30", "1.2.3-rc.1", "1.2.3-rc.1+build.5", "1.2.3+build"])(
    "accepts the SemVer version %s",
    (version) => {
      expect(check({ version }).ok).toBe(true);
    },
  );

  it.each(["1.0", "v1.0.0", "01.0.0", "1.0.0.0", "", ">=1.0.0", "1.0.x"])(
    "refuses the non-version %s",
    (version) => {
      expect(check({ version }).ok).toBe(false);
    },
  );

  it("parses the version parts, including prerelease and build metadata", () => {
    expect(parseTemplatePackageVersion("1.2.3-rc.1+build.5")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: "rc.1",
      build: "build.5",
    });
    expect(parseTemplatePackageVersion("1.2")).toBeUndefined();
  });
});

describe("the closed category and framework vocabularies", () => {
  it("accepts every declared category and framework", () => {
    for (const category of TEMPLATE_PACKAGE_CATEGORIES) {
      expect(check({ category }).ok).toBe(true);
    }
    for (const framework of TEMPLATE_PACKAGE_FRAMEWORKS) {
      expect(check({ framework }).ok).toBe(true);
    }
  });

  it("refuses a category or framework outside the vocabulary", () => {
    rejects(check({ category: "desktop" }), "category", /one of frontend, backend/u);
    rejects(check({ framework: "vue" }), "framework", /one of h5, vue3/u);
  });
});

describe("text fields", () => {
  it("requires a non-empty name within the limit", () => {
    rejects(check({ name: undefined }), "name", /required/u);
    rejects(check({ name: "" }), "name", /must not be empty/u);
    rejects(check({ name: "a".repeat(DEFAULT_TEMPLATE_PACKAGE_LIMITS.maxNameLength + 1) }), "name");
  });

  it("allows an omitted description but not an empty or oversized one", () => {
    expect(check().ok).toBe(true);
    rejects(check({ description: "" }), "description");
    rejects(
      check({ description: "a".repeat(DEFAULT_TEMPLATE_PACKAGE_LIMITS.maxDescriptionLength + 1) }),
      "description",
    );
  });

  it("refuses a control character in a display field, so a result cannot rewrite a line", () => {
    rejects(check({ name: "Acme\u001b[31m" }), "name", /control character/u);
    rejects(check({ description: "line\nbreak" }), "description", /control character/u);
    rejects(
      check({ provenance: { author: "Acme\u0007", createdAt: "2026-10-18T00:00:00Z" } }),
      "provenance.author",
      /control character/u,
    );
  });

  it("refuses tags that are not lowercase slugs or that repeat", () => {
    rejects(check({ tags: ["Vue 3"] }), "tags[0]");
    rejects(check({ tags: ["vue", "vue"] }), "tags[1]", /duplicates/u);
    rejects(check({ tags: "vue" }), "tags");
  });

  it("bounds the number of tags", () => {
    const limits = { ...DEFAULT_TEMPLATE_PACKAGE_LIMITS, maxTags: 1 };
    rejects(check({ tags: ["one", "two"] }, undefined, limits), "tags");
  });

  it("bounds one tag's length by the named limit", () => {
    const limit = DEFAULT_TEMPLATE_PACKAGE_LIMITS.maxTagLength;
    expect(check({ tags: ["a".repeat(limit)] }).ok).toBe(true);
    rejects(check({ tags: ["a".repeat(limit + 1)] }), "tags[0]");
  });
});

describe("requirements and variables", () => {
  it.each([">=1.7.0", "1.7.0", ">=1.7.0 <2.0.0", "=1.7.0", "<=2.0.0 >1.0.0"])(
    "accepts the requirement %s",
    (requirement) => {
      expect(check({ requires: { libuvcpp: requirement } }).ok).toBe(true);
    },
  );

  it.each(["1.7", "v1.7.0", ">=1.7", " 1.7.0", "", "~1.7.0", "1.7.x"])(
    "refuses the requirement %s",
    (requirement) => {
      expect(check({ requires: { uvp: requirement } }).ok).toBe(false);
      expect(templateVersionRequirementProblem(requirement)).toBeDefined();
    },
  );

  it("refuses an unknown feature or a duplicate one", () => {
    rejects(check({ requires: { features: ["quantum"] } }), "requires.features[0]");
    rejects(check({ requires: { features: ["tls", "tls"] } }), "requires.features[1]");
    expect(check({ requires: { features: ["tls", "websocket"] } }).ok).toBe(true);
  });

  it("accepts the two placeholders with their declared types", () => {
    expect(
      check({
        variables: {
          name: { type: "slug", required: true, default: "my-app" },
          port: { type: "port", default: 8080 },
        },
      }).ok,
    ).toBe(true);
  });

  it("refuses a variable for a placeholder the format does not have", () => {
    rejects(check({ variables: { title: { type: "slug" } } }), "variables.title", /placeholders/u);
  });

  it("refuses a wrong type, a bad default, and an unknown key", () => {
    rejects(check({ variables: { port: { type: "slug" } } }), "variables.port.type");
    rejects(check({ variables: { port: { type: "port", default: 0 } } }), "variables.port.default");
    rejects(
      check({ variables: { port: { type: "port", default: 1.5 } } }),
      "variables.port.default",
    );
    rejects(
      check({ variables: { name: { type: "slug", default: "My App" } } }),
      "variables.name.default",
    );
    rejects(
      check({ variables: { port: { type: "port", required: "yes" } } }),
      "variables.port.required",
    );
  });
});

describe("licence and provenance", () => {
  it("requires a licence, an SPDX id or name, and the LICENSE file", () => {
    rejects(check({ license: undefined }), "license", /required/u);
    rejects(check({ license: { file: "LICENSE" } }), "license", /spdx or name/u);
    rejects(check({ license: { spdx: "MIT", file: "COPYING" } }), "license.file");
    rejects(
      check({ license: { spdx: "MIT OR Apache-2.0", file: "LICENSE" } }),
      "license.spdx",
      /single SPDX identifier/u,
    );
    expect(check({ license: { name: "Acme Internal", file: "LICENSE" } }).ok).toBe(true);
  });

  it("bounds author, revision, licence name, and SPDX id by the named limits", () => {
    const limits = DEFAULT_TEMPLATE_PACKAGE_LIMITS;
    rejects(
      check({
        provenance: {
          author: "a".repeat(limits.maxAuthorLength + 1),
          createdAt: "2026-10-18T00:00:00Z",
        },
      }),
      "provenance.author",
    );
    rejects(
      check({
        provenance: {
          author: "Acme",
          createdAt: "2026-10-18T00:00:00Z",
          revision: "a".repeat(limits.maxRevisionLength + 1),
        },
      }),
      "provenance.revision",
    );
    rejects(
      check({ license: { name: "a".repeat(limits.maxLicenseNameLength + 1), file: "LICENSE" } }),
      "license.name",
    );
    rejects(
      check({ license: { spdx: "a".repeat(limits.maxSpdxLength + 1), file: "LICENSE" } }),
      "license.spdx",
    );
  });

  it("requires an author and a UTC creation time", () => {
    rejects(check({ provenance: { createdAt: "2026-10-18T00:00:00Z" } }), "provenance.author");
    rejects(
      check({ provenance: { author: "Acme", createdAt: "2026-10-18" } }),
      "provenance.createdAt",
    );
    rejects(
      check({ provenance: { author: "Acme", createdAt: "2026-10-18T00:00:00+02:00" } }),
      "provenance.createdAt",
    );
    rejects(
      check({ provenance: { author: "Acme", createdAt: "2026-13-18T00:00:00Z" } }),
      "provenance.createdAt",
    );
    // `Date.parse` would roll this into 3 March; the calendar has no 31 February.
    rejects(
      check({ provenance: { author: "Acme", createdAt: "2026-02-31T00:00:00Z" } }),
      "provenance.createdAt",
      /UTC ISO-8601/u,
    );
  });

  it("accepts an http(s) source without credentials and refuses anything else", () => {
    expect(
      check({
        provenance: {
          author: "Acme",
          createdAt: "2026-10-18T00:00:00Z",
          source: "https://example.test/acme/template",
          revision: "abc123",
        },
      }).ok,
    ).toBe(true);
    rejects(
      check({
        provenance: {
          author: "Acme",
          createdAt: "2026-10-18T00:00:00Z",
          source: "git@example.test:x",
        },
      }),
      "provenance.source",
    );
    rejects(
      check({
        provenance: {
          author: "Acme",
          createdAt: "2026-10-18T00:00:00Z",
          source: "https://user:secret@example.test/x",
        },
      }),
      "provenance.source",
      /credentials/u,
    );
  });
});

describe("preview", () => {
  it("accepts the three preview names and refuses any other", () => {
    for (const preview of ["preview.png", "preview.svg", "preview.webp"]) {
      expect(check({ preview }).ok).toBe(true);
    }
    rejects(check({ preview: "screenshot.png" }), "preview");
    rejects(check({ preview: "preview.gif" }), "preview");
  });
});

describe("routes", () => {
  it("accepts the declared methods, parameters, and subtree paths", () => {
    const routes = [
      "GET /hello",
      "HEAD /",
      "POST /items",
      "PUT /items/:id",
      "PATCH /items/:id",
      "DELETE /items/:id",
      "OPTIONS /items",
      "WS /echo",
      "GET /*path",
    ];
    const result = check({ routes });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The declaration's order is kept: it is the package author's, and a reader
    // comparing the rendered source to the manifest should not have to sort.
    expect(result.manifest.routes).toEqual(routes);
  });

  it("omits an absent declaration rather than reading it as no routes", () => {
    const result = check();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.routes).toBeUndefined();
  });

  it("refuses a value that is not a list of strings", () => {
    rejects(check({ routes: "GET /hello" }), "routes", /array/u);
    rejects(check({ routes: [42] }), "routes.0", /string/u);
  });

  it.each([
    ["no method", "/hello"],
    ["a lowercase method", "get /hello"],
    ["no space", "GET"],
    ["whitespace in the path", "GET /hello world"],
    ["an absolute URL", "GET http://example.test/hello"],
  ])("refuses %s", (_label, route) => {
    rejects(check({ routes: [route] }), "routes.0", /METHOD \/path/u);
  });

  it("refuses a method the route table does not name", () => {
    rejects(check({ routes: ["TRACE /hello"] }), "routes.0", /method must be one of/u);
  });

  it("refuses a control character, which would reach the terminal raw", () => {
    // `uvp init` prints each route through `row()`, which pads but does not
    // sanitise: an escape sequence would erase and repaint the line a caller
    // already read. The same rule `name` and `description` carry applies here.
    rejects(check({ routes: ["GET /\u001b[2Kred"] }), "routes.0", /control character/u);
    rejects(check({ routes: ["GET /a\u0000b"] }), "routes.0", /control character/u);
  });

  it("accepts a non-ASCII path, which the control-character rule does not refuse", () => {
    const result = check({ routes: ["GET /你好"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.routes).toEqual(["GET /你好"]);
  });

  it("refuses a duplicate and names the entry", () => {
    rejects(check({ routes: ["GET /hello", "GET /hello"] }), "routes.1", /duplicates/u);
  });

  it("bounds the list and the path length", () => {
    // A short declared path keeps the file rule out of a test about routes.
    const shortFile = { files: [{ path: "a.cc", digest: DIGEST_A, bytes: 1 }] };
    const counts = { ...DEFAULT_TEMPLATE_PACKAGE_LIMITS, maxRoutes: 2 };
    expect(check({ ...shortFile, routes: ["GET /a", "GET /b"] }, undefined, counts).ok).toBe(true);
    rejects(
      check({ ...shortFile, routes: ["GET /a", "GET /b", "GET /c"] }, undefined, counts),
      "routes",
    );
    const lengths = { ...DEFAULT_TEMPLATE_PACKAGE_LIMITS, maxPathLength: 8 };
    rejects(
      check({ ...shortFile, routes: ["GET /abcdefghij"] }, undefined, lengths),
      "routes.0",
      /path/u,
    );
  });
});

describe("file paths", () => {
  it.each([
    ["a source file", "src/main.cc", true],
    ["a nested asset", "assets/logo.png", true],
    ["a path naming the files/ directory", "files/src/main.cc", false],
    ["a file named files", "files", false],
    ["a hidden file", ".gitignore", true],
    ["an absolute path", "/etc/passwd", false],
    ["a Windows drive path", "C:/Windows/system.ini", false],
    ["a backslash separator", "src\\main.cc", false],
    ["a traversal segment", "../outside.cc", false],
    ["a traversal in the middle", "src/../../outside.cc", false],
    ["a current-directory segment", "src/./main.cc", false],
    ["an empty segment", "src//main.cc", false],
    ["a Windows-reserved character", "src/a?.cc", false],
    ["a reserved device name", "src/con.txt", false],
    ["a trailing dot", "src/main.", false],
    ["a trailing space", "src/main ", false],
    ["a control character", "src/a\u0001.cc", false],
    ["an empty path", "", false],
  ])("%s", (_label, path, accepted) => {
    expect(templatePackagePathProblem(path) === undefined).toBe(accepted);
  });

  it("bounds the path length", () => {
    const limits = { ...DEFAULT_TEMPLATE_PACKAGE_LIMITS, maxPathLength: 8 };
    expect(templatePackagePathProblem("abc/def", limits)).toBeUndefined();
    expect(templatePackagePathProblem("abcdefghij", limits)).toBeDefined();
  });
});

describe("the declared file list", () => {
  it("refuses an empty list, a traversal path, a bad digest, and bad sizes", () => {
    rejects(check({ files: [] }), "files", /at least one/u);
    rejects(check({ files: [{ path: "../x", digest: DIGEST_A, bytes: 1 }] }), "files[0].path");
    rejects(check({ files: [{ path: "x", digest: "sha256:ABC", bytes: 1 }] }), "files[0].digest");
    rejects(check({ files: [{ path: "x", digest: DIGEST_A, bytes: -1 }] }), "files[0].bytes");
    rejects(check({ files: [{ path: "x", digest: DIGEST_A }] }), "files[0].bytes");
  });

  it("refuses archives and compiled binaries in the source list", () => {
    rejects(
      check({ files: [{ path: "vendor.tar.gz", digest: DIGEST_A, bytes: 1 }] }),
      "files[0].path",
    );
    rejects(
      check({ files: [{ path: "lib/libfoo.so", digest: DIGEST_A, bytes: 1 }] }),
      "files[0].path",
    );
  });

  it("refuses paths that collide case-insensitively, which one host would overwrite", () => {
    rejects(
      check({
        files: [
          { path: "README.md", digest: DIGEST_A, bytes: 1 },
          { path: "readme.md", digest: DIGEST_B, bytes: 1 },
        ],
      }),
      "files[1].path",
      /case-insensitively/u,
    );
  });

  it("bounds the file count, each file's size, and the total", () => {
    rejects(
      check(
        {
          files: [
            { path: "a", digest: DIGEST_A, bytes: 1 },
            { path: "b", digest: DIGEST_A, bytes: 1 },
          ],
        },
        undefined,
        { ...DEFAULT_TEMPLATE_PACKAGE_LIMITS, maxFiles: 1 },
      ),
      "files",
    );
    rejects(
      check({ files: [{ path: "a", digest: DIGEST_A, bytes: 120 }] }, undefined, {
        ...DEFAULT_TEMPLATE_PACKAGE_LIMITS,
        maxFileBytes: 100,
        maxTotalBytes: 1000,
      }),
      "files[0].bytes",
    );
    rejects(
      check({ files: [{ path: "a", digest: DIGEST_A, bytes: 120 }] }, undefined, {
        ...DEFAULT_TEMPLATE_PACKAGE_LIMITS,
        maxTotalBytes: 100,
      }),
      "files",
      /120 bytes/u,
    );
  });
});

describe("the reader's observations", () => {
  const observation = (overrides: Partial<TemplatePackageFileObservation> = {}) => ({
    path: "src/main.cc",
    bytes: 120,
    ...overrides,
  });

  it("accepts a listing that agrees with the manifest", () => {
    const result = check({}, [observation({ digest: DIGEST_A })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filesObserved).toBe(true);
  });

  it("names a case-only difference as such, rather than as an unrelated file", () => {
    rejects(check({}, [observation({ path: "SRC/main.cc" })]), "files[0]", /differs only in case/u);
  });

  it("does not invent a digest, symlink, or binary check the reader did not report", () => {
    // The observation says only path and bytes: the other three properties
    // were not examined, and the validator must not read silence as success
    // or as failure.
    expect(check({}, [observation()]).ok).toBe(true);
  });

  it("refuses a declared file the reader did not observe", () => {
    rejects(check({}, []), "files", /did not observe/u);
  });

  it("refuses an observed file the manifest does not declare", () => {
    rejects(
      check({}, [observation(), observation({ path: "extra.cc", bytes: 1 })]),
      "files[1]",
      /not listed/u,
    );
  });

  it("refuses a size or digest that disagrees with the manifest", () => {
    rejects(check({}, [observation({ bytes: 121 })]), "files[0]", /121 bytes/u);
    rejects(check({}, [observation({ digest: DIGEST_B })]), "files[0]", /digest/u);
  });

  it("refuses a symlink and a binary outside assets/", () => {
    rejects(check({}, [observation({ symlink: true })]), "files[0]", /symlink/u);
    rejects(check({}, [observation({ binary: true })]), "files[0]", /outside assets/u);
    expect(
      check({ files: [{ path: "assets/logo.png", digest: DIGEST_A, bytes: 120 }] }, [
        { path: "assets/logo.png", bytes: 120, binary: true },
      ]).ok,
    ).toBe(true);
  });

  it("refuses a listing that reports the same path twice", () => {
    rejects(check({}, [observation(), observation()]), "files[1]", /duplicates/u);
  });

  it("bounds the observed total as well as the declared one", () => {
    rejects(
      check({}, [observation()], { ...DEFAULT_TEMPLATE_PACKAGE_LIMITS, maxTotalBytes: 100 }),
      "files",
      /reader observed/u,
    );
  });
});
