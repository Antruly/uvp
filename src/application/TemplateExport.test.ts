import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TemplateStoreError, getTemplatePackage, importTemplatePackage } from "./TemplateStore.js";
import { exportTemplatePackage } from "./TemplateExport.js";
import { makeTemplatePackage } from "../../tests/support/templatePackageFixture.js";

/**
 * Export is the store's other direction: the bytes a caller receives must be
 * the bytes the manifest describes. The round trip is the strongest check
 * available without a registry — import, export, and import the export into a
 * second store must agree on the manifest digest and the file list — and the
 * refusal cases matter as much, because "export over my directory" is not
 * something the caller can undo.
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

const storeWithPackage = async (): Promise<{
  readonly storeRoot: string;
  readonly content: string;
}> => {
  const source = await temporaryRoot("uvp-export-source-");
  const fixture = await makeTemplatePackage({ root: source });
  const storeRoot = path.join(await temporaryRoot("uvp-export-store-"), "store");
  await importTemplatePackage({ sourceDir: fixture.dir, storeRoot });
  return { storeRoot, content: fixture.content };
};

const codeOf = async (operation: Promise<unknown>): Promise<string> => {
  try {
    await operation;
  } catch (error) {
    if (error instanceof TemplateStoreError) return error.code;
    throw error;
  }
  return "no error";
};

describe("exporting a template package", () => {
  it("round-trips a stored package into a second store with the same digest", async () => {
    const { storeRoot, content } = await storeWithPackage();
    const target = path.join(await temporaryRoot("uvp-export-target-"), "out");

    const exported = await exportTemplatePackage("acme-dashboard", "1.2.0", {
      storeRoot,
      targetDir: target,
    });

    expect(exported.path).toBe(target);
    expect(exported.bytes).toBe(Buffer.byteLength(content));
    expect(exported.files.map((file) => file.path)).toEqual(["src/main.cc"]);
    expect(await readFile(path.join(target, "files", "src", "main.cc"), "utf8")).toBe(content);
    expect(await readFile(path.join(target, "template.json"), "utf8")).toContain("uvp.template/1");

    const secondStore = path.join(await temporaryRoot("uvp-export-store2-"), "store");
    const reimported = await importTemplatePackage({ sourceDir: target, storeRoot: secondStore });
    expect(reimported.package.digest).toBe(exported.digest);

    const original = await getTemplatePackage("acme-dashboard", "1.2.0", { storeRoot });
    expect(reimported.package.files).toEqual(original.files);
  });

  it("refuses a non-empty target and leaves its contents alone", async () => {
    const { storeRoot } = await storeWithPackage();
    const target = await temporaryRoot("uvp-export-occupied-");
    await writeFile(path.join(target, "keep.txt"), "do not touch\n");

    expect(
      await codeOf(
        exportTemplatePackage("acme-dashboard", "1.2.0", { storeRoot, targetDir: target }),
      ),
    ).toBe("target_exists");
    expect(await readFile(path.join(target, "keep.txt"), "utf8")).toBe("do not touch\n");
    await expect(access(path.join(target, "files"))).rejects.toThrow();
  });

  it("refuses a target that is a file, and the stored entry itself", async () => {
    const { storeRoot } = await storeWithPackage();
    const root = await temporaryRoot("uvp-export-file-");
    const file = path.join(root, "file.txt");
    await writeFile(file, "x");

    expect(
      await codeOf(
        exportTemplatePackage("acme-dashboard", "1.2.0", { storeRoot, targetDir: file }),
      ),
    ).toBe("target_exists");
    expect(
      await codeOf(
        exportTemplatePackage("acme-dashboard", "1.2.0", {
          storeRoot,
          targetDir: path.join(storeRoot, "acme-dashboard", "1.2.0"),
        }),
      ),
    ).toBe("target_exists");
  });

  it("refuses a target inside the stored package and leaves the package untouched", async () => {
    const { storeRoot } = await storeWithPackage();
    const storedEntry = path.join(storeRoot, "acme-dashboard", "1.2.0");
    const before = (await readdir(storedEntry)).sort();

    // `..out` is a child whose name starts with `..`; it must not be mistaken
    // for a path outside the stored tree.
    for (const name of ["out", "..out"]) {
      const target = path.join(storedEntry, name);
      expect(
        await codeOf(
          exportTemplatePackage("acme-dashboard", "1.2.0", { storeRoot, targetDir: target }),
        ),
      ).toBe("target_exists");
      // The staging directory would have been a sibling of the target, inside
      // the tree being copied; nothing may be created there.
      expect((await readdir(storedEntry)).sort()).toEqual(before);
      await expect(access(target)).rejects.toThrow();
    }
  });

  it("does not create the target when the store entry no longer matches its manifest", async () => {
    const { storeRoot } = await storeWithPackage();
    await writeFile(
      path.join(storeRoot, "acme-dashboard", "1.2.0", "files", "src", "main.cc"),
      "int main() { return 1; }\n",
    );
    const target = path.join(await temporaryRoot("uvp-export-bad-"), "out");

    expect(
      await codeOf(
        exportTemplatePackage("acme-dashboard", "1.2.0", { storeRoot, targetDir: target }),
      ),
    ).toBe("invalid_package");
    await expect(access(target)).rejects.toThrow();
  });

  it("says not_found for a package the store does not hold", async () => {
    const storeRoot = path.join(await temporaryRoot("uvp-export-empty-"), "store");
    await mkdir(storeRoot, { recursive: true });
    const target = path.join(await temporaryRoot("uvp-export-none-"), "out");

    expect(
      await codeOf(
        exportTemplatePackage("absent-package", "1.0.0", { storeRoot, targetDir: target }),
      ),
    ).toBe("not_found");
  });
});
