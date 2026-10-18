import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  TemplateStoreError,
  importTemplatePackage,
  inspectTemplatePackage,
} from "./TemplateStore.js";
import { makeTemplatePackage } from "../../tests/support/templatePackageFixture.js";

/**
 * The dry run is only useful if it is the import's verdict without the write.
 * These tests hold that equality: the same source that imports gives the same
 * digest and file list here, the same source that is refused throws the same
 * error, and the store the caller named is not created.
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

interface CodedError {
  readonly code: string;
  readonly details: readonly string[];
}

/** Run a call that must throw, and return the store error it carried. */
const expectCode = async (operation: () => Promise<unknown>): Promise<CodedError> => {
  try {
    await operation();
  } catch (error) {
    if (error instanceof TemplateStoreError) {
      return { code: error.code, details: [...error.details] };
    }
    throw error;
  }
  throw new Error("the call completed but was expected to throw");
};

describe("inspecting a template package", () => {
  it("reports what import would write, without creating the store", async () => {
    const source = await temporaryRoot("uvp-inspect-source-");
    const fixture = await makeTemplatePackage({ root: source });
    const storeRoot = path.join(await temporaryRoot("uvp-inspect-store-"), "store");

    const inspected = await inspectTemplatePackage({ sourceDir: fixture.dir });

    expect(inspected.id).toBe("acme-dashboard");
    expect(inspected.version).toBe("1.2.0");
    expect(inspected.files.map((file) => file.path)).toEqual(["src/main.cc"]);
    expect(inspected.unverified).toBe(false);
    // The dry run names no store entry, because none exists yet.
    expect("path" in inspected).toBe(false);
    // Nothing was created: the store root itself is absent.
    await expect(access(storeRoot)).rejects.toThrow();

    const imported = await importTemplatePackage({ sourceDir: fixture.dir, storeRoot });
    expect(imported.package.digest).toBe(inspected.digest);
    expect(imported.package.files).toEqual(inspected.files);
    // The dry run is the import's summary minus the store path: every other
    // field must agree, so a field the import adds cannot be dropped here.
    const { path: packagePath, ...importedFields } = imported.package;
    expect(packagePath).toBe(path.join(storeRoot, "acme-dashboard", "1.2.0"));
    expect(inspected).toEqual(importedFields);
  });

  it("refuses the source import refuses, with the same code and problems", async () => {
    const source = await temporaryRoot("uvp-inspect-bad-");
    const fixture = await makeTemplatePackage({
      root: source,
      overrides: { version: "not-semver" },
    });

    const inspectError = await expectCode(() => inspectTemplatePackage({ sourceDir: fixture.dir }));
    expect(inspectError.code).toBe("invalid_package");
    expect(inspectError.details.length).toBeGreaterThan(0);

    const importError = await expectCode(() =>
      importTemplatePackage({ sourceDir: fixture.dir, storeRoot: path.join(source, "store") }),
    );
    expect(importError.code).toBe(inspectError.code);
    expect(importError.details).toEqual(inspectError.details);
  });

  it("treats licence and provenance the way the import option does", async () => {
    const source = await temporaryRoot("uvp-inspect-unverified-");
    const fixture = await makeTemplatePackage({
      root: source,
      overrides: { license: null, provenance: null },
    });

    expect((await expectCode(() => inspectTemplatePackage({ sourceDir: fixture.dir }))).code).toBe(
      "invalid_package",
    );

    const inspected = await inspectTemplatePackage({
      sourceDir: fixture.dir,
      allowUnverified: true,
    });
    expect(inspected.unverified).toBe(true);
    expect(inspected.license).toBeUndefined();
    expect(inspected.provenance).toBeUndefined();
  });
});
