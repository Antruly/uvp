import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_TEMPLATE_SCAN_LIMITS, scanTemplatePackage } from "./TemplateScan.js";
import { makeTemplatePackage } from "../../tests/support/templatePackageFixture.js";

/**
 * The scan is a locator, not a guarantee. These tests hold both halves: each
 * documented rule fires on its shape and never repeats the value it matched,
 * and the result accounts for every file it did and did not read — a skipped
 * binary, an oversized file, and a spent budget are all named rather than
 * silently absent, so "no findings" cannot be read as "scanned everything".
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

const SECRETS = [
  'const char* key = "AKIAIOSFODNN7EXAMPLE";',
  'const char* gh = "ghp_0123456789012345678901234567890123456789";',
  'const char* slack = "xoxb-123456789012-abcdefghij";',
  'const char* provider = "sk-abcdefghijklmnopqrstuvwx";',
  "API_TOKEN=supersecretvalue123",
  "path = /home/alice/projects/app",
  "mail: alice@example.com",
  "call +86 138 0013 8000",
  "-----BEGIN RSA PRIVATE KEY-----",
].join("\n");

describe("scanning a template package", () => {
  it("reports each credential and PII shape with a masked excerpt", async () => {
    const root = await temporaryRoot("uvp-scan-");
    const fixture = await makeTemplatePackage({ root });
    await writeFile(path.join(fixture.dir, "files", "src", "secrets.txt"), `${SECRETS}\n`);

    const result = await scanTemplatePackage(fixture.dir);

    const rules = result.findings.map((finding) => finding.rule).sort();
    expect(rules).toEqual([
      "aws_access_key",
      "email",
      "github_token",
      "home_path",
      "phone",
      "private_key",
      "provider_token",
      "secret_assignment",
      "slack_token",
    ]);
    for (const finding of result.findings) {
      expect(finding.path).toBe("files/src/secrets.txt");
      expect(finding.line).toBeGreaterThan(0);
      // The finding says where to look; it must not hand the secret on.
      expect(finding.redacted).not.toContain("supersecretvalue123");
      expect(finding.redacted).not.toContain("IOSFODNN7EXAMPLE");
      expect(finding.redacted).not.toContain("alice");
      expect(finding.redacted).not.toContain("138 0013 8000");
    }
    const byRule = new Map(result.findings.map((finding) => [finding.rule, finding.redacted]));
    expect(byRule.get("home_path")).toBe("/home/…/");
    expect(byRule.get("email")).toBe("a…@example.com");
    expect(byRule.get("secret_assignment")).toBe("API_TOKEN=…");
    expect(result.truncated).toBe(false);
    expect(result.scanned).toContain("files/src/secrets.txt");
    expect(result.scanned).toContain("template.json");
  });

  it("reports nothing for a package with no matching shape, and says what it read", async () => {
    const root = await temporaryRoot("uvp-scan-clean-");
    const fixture = await makeTemplatePackage({ root });

    const result = await scanTemplatePackage(fixture.dir);

    expect(result.findings).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.truncated).toBe(false);
    expect([...result.scanned].sort()).toEqual([
      "LICENSE",
      "README.md",
      "files/src/main.cc",
      "template.json",
    ]);
    expect(result.limits).toEqual(DEFAULT_TEMPLATE_SCAN_LIMITS);
  });

  it("skips binary content and names it, instead of reading it as text", async () => {
    const root = await temporaryRoot("uvp-scan-binary-");
    const fixture = await makeTemplatePackage({ root });
    await writeFile(
      path.join(fixture.dir, "files", "src", "logo.bin"),
      Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]),
    );

    const result = await scanTemplatePackage(fixture.dir);

    expect(result.scanned).not.toContain("files/src/logo.bin");
    expect(result.skipped).toEqual([
      { path: "files/src/logo.bin", reason: "binary content (contains a NUL byte)" },
    ]);
  });

  it("refuses to read a file over the byte limit, so the limit bounds memory", async () => {
    const root = await temporaryRoot("uvp-scan-large-");
    const fixture = await makeTemplatePackage({ root, content: "int main() {}\n" });

    const result = await scanTemplatePackage(fixture.dir, {
      limits: { maxFileBytes: 8 },
    });

    expect(result.scanned).not.toContain("files/src/main.cc");
    expect(result.skipped).toEqual(
      expect.arrayContaining([{ path: "files/src/main.cc", reason: "larger than 8 bytes" }]),
    );
    expect(result.truncated).toBe(false);
  });

  it("stops at the findings cap and names the files it did not examine", async () => {
    const root = await temporaryRoot("uvp-scan-cap-");
    const fixture = await makeTemplatePackage({ root });
    await writeFile(path.join(fixture.dir, "files", "src", "a.txt"), `${SECRETS}\n`);
    await writeFile(path.join(fixture.dir, "files", "src", "b.txt"), `${SECRETS}\n`);

    const result = await scanTemplatePackage(fixture.dir, { limits: { maxFindings: 2 } });

    expect(result.findings).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.skipped.some((entry) => entry.reason.includes("findings limit"))).toBe(true);
    expect(result.scanned).not.toContain("files/src/b.txt");
  });

  it("stops when the total byte budget is spent", async () => {
    const root = await temporaryRoot("uvp-scan-budget-");
    const fixture = await makeTemplatePackage({ root });

    const result = await scanTemplatePackage(fixture.dir, { limits: { maxTotalBytes: 0 } });

    expect(result.truncated).toBe(true);
    expect(result.scanned).toEqual([]);
    expect(result.skipped.some((entry) => entry.reason.includes("budget"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("does not follow a symlink", async () => {
    const root = await temporaryRoot("uvp-scan-link-");
    const fixture = await makeTemplatePackage({ root });
    await symlink(
      path.join(fixture.dir, "files", "src", "main.cc"),
      path.join(fixture.dir, "files", "src", "link.cc"),
    );

    const result = await scanTemplatePackage(fixture.dir);

    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { path: "files/src/link.cc", reason: "symbolic link (not followed)" },
      ]),
    );
  });

  it("says the directory is missing or not a directory, rather than scanning nothing", async () => {
    const root = await temporaryRoot("uvp-scan-missing-");
    await writeFile(path.join(root, "file"), "x");

    await expect(scanTemplatePackage(path.join(root, "absent"))).rejects.toMatchObject({
      code: "io_error",
    });
    await expect(scanTemplatePackage(path.join(root, "file"))).rejects.toMatchObject({
      code: "invalid_package",
    });
  });
});
