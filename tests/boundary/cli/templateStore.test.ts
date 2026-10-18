import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { requireToolContract } from "../../../src/contracts/toolContracts.js";
import { makeTemplatePackage } from "../../support/templatePackageFixture.js";

/**
 * The template commands as a process.
 *
 * The application layer already has store, search, inspect, export, and scan
 * tests. This lane asks the question none of them can: do the six contracts,
 * the CLI lowering, the handler dispatch, and the store all agree when a caller
 * types the words? It exercises the complete local lifecycle against a real
 * temporary store.
 */

const exec = promisify(execFile);
const REPOSITORY = path.resolve(import.meta.dirname, "..", "..", "..");
const UVP = path.join(REPOSITORY, "scripts", "uvp.mjs");
const TIMEOUT_MS = 30_000;

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "uvp-template-cli-"));
  roots.push(root);
  return root;
};

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const run = async (args: readonly string[], env: Record<string, string>): Promise<RunResult> => {
  try {
    const { stdout, stderr } = await exec(process.execPath, [UVP, ...args], {
      env: { ...process.env, ...env },
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
};

const json = (result: RunResult): Record<string, unknown> =>
  JSON.parse(result.stdout) as Record<string, unknown>;

const failureOf = (result: RunResult): Record<string, unknown> =>
  JSON.parse(result.stderr) as Record<string, unknown>;

/** Every successful result is the contract's output, not merely JSON. */
const expectContractOutput = (tool: string, output: Record<string, unknown>): void => {
  const parsed = requireToolContract(tool).outputSchema.safeParse(output);
  const issues = parsed.success
    ? ""
    : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  expect(parsed.success, `${tool} output did not match its schema: ${issues}`).toBe(true);
};

describe("the template commands", () => {
  it("validates, imports, searches, gets, exports, and removes a package", async () => {
    const root = await temporaryRoot();
    const store = path.join(root, "store");
    const env = { UVP_TEMPLATE_HOME: store };
    const fixture = await makeTemplatePackage({ root });

    const validated = await run(["template", "validate", fixture.dir, "--json"], env);
    expect(validated.code).toBe(0);
    expect(json(validated)["id"]).toBe("acme-dashboard");

    const dryRun = await run(["template", "import", fixture.dir, "--dry-run", "--json"], env);
    expect(dryRun.code).toBe(0);
    expect(json(dryRun)["dry_run"]).toBe(true);
    const empty = await run(["template", "search", "--json"], env);
    expect(json(empty)["matches"]).toEqual([]);

    const imported = await run(["template", "import", fixture.dir, "--json"], env);
    expect(imported.code).toBe(0);
    expect(json(imported)["path"]).toBe(path.join(store, "acme-dashboard", "1.2.0"));

    const searched = await run(["template", "search", "--category", "fullstack", "--json"], env);
    expect(searched.code).toBe(0);
    const matches = json(searched)["matches"] as readonly { id: string }[];
    expect(matches.map((match) => match.id)).toEqual(["acme-dashboard"]);

    const got = await run(["template", "get", "acme-dashboard@1.2.0", "--json"], env);
    expect(got.code).toBe(0);
    expect(json(got)["version"]).toBe("1.2.0");

    const target = path.join(root, "exported");
    const exported = await run(
      ["template", "export", "acme-dashboard@1.2.0", "--target", target, "--json"],
      env,
    );
    expect(exported.code).toBe(0);
    expect(json(exported)["path"]).toBe(target);

    const removed = await run(["template", "remove", "acme-dashboard@1.2.0", "--json"], env);
    expect(removed.code).toBe(0);
    const after = await run(["template", "search", "--json"], env);
    expect(json(after)["matches"]).toEqual([]);
  });

  it("reports a missing package as a failure, not an empty result", async () => {
    const root = await temporaryRoot();
    const result = await run(["template", "get", "missing@1.0.0", "--json"], {
      UVP_TEMPLATE_HOME: path.join(root, "store"),
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not in the store");
  });

  it("refuses a trailing @ instead of widening a removal to every version", async () => {
    const root = await temporaryRoot();
    const store = path.join(root, "store");
    const env = { UVP_TEMPLATE_HOME: store };
    const fixture = await makeTemplatePackage({ root });
    expect((await run(["template", "import", fixture.dir, "--json"], env)).code).toBe(0);

    const refused = await run(["template", "remove", "acme-dashboard@", "--json"], env);
    expect(refused.code).toBe(2);
    expect(failureOf(refused)["code"]).toBe("invalid_request");
    expect(String(failureOf(refused)["message"])).toContain("no version after '@'");

    // The refusal happened before any removal: the package is still readable.
    const after = await run(["template", "get", "acme-dashboard@1.2.0", "--json"], env);
    expect(after.code).toBe(0);
  });

  it("tells a dry run what the same import would do", async () => {
    const root = await temporaryRoot();
    const store = path.join(root, "store");
    const env = { UVP_TEMPLATE_HOME: store };
    const fixture = await makeTemplatePackage({ root });
    expect((await run(["template", "import", fixture.dir, "--json"], env)).code).toBe(0);

    const refused = await run(["template", "import", fixture.dir, "--dry-run", "--json"], env);
    expect(refused.code).toBe(0);
    const refusedOutput = json(refused);
    expectContractOutput("uvp_template_import", refusedOutput);
    expect(refusedOutput["dry_run"]).toBe(true);
    expect(refusedOutput["would_import"]).toBe(false);
    expect(refusedOutput["would_replace"]).toBe(false);
    expect(String(refusedOutput["conflict"])).toContain("pass replace");

    const replacing = await run(
      ["template", "import", fixture.dir, "--dry-run", "--replace", "--json"],
      env,
    );
    expect(replacing.code).toBe(0);
    const replacingOutput = json(replacing);
    expectContractOutput("uvp_template_import", replacingOutput);
    expect(replacingOutput["would_import"]).toBe(true);
    expect(replacingOutput["would_replace"]).toBe(true);
    expect(replacingOutput["conflict"]).toBeUndefined();

    // A dry run writes nothing, so the store still holds exactly one entry.
    const listed = await run(["template", "search", "--json"], env);
    expect((json(listed)["matches"] as readonly unknown[]).length).toBe(1);
  });

  it("carries one error code per store failure", async () => {
    const root = await temporaryRoot();
    const store = path.join(root, "store");
    const env = { UVP_TEMPLATE_HOME: store };
    const fixture = await makeTemplatePackage({ root });
    expect((await run(["template", "import", fixture.dir, "--json"], env)).code).toBe(0);

    const missing = await run(["template", "get", "acme-dashboard@9.9.9", "--json"], env);
    expect(missing.code).toBe(2);
    expect(failureOf(missing)["code"]).toBe("template_not_found");

    const duplicate = await run(["template", "import", fixture.dir, "--json"], env);
    expect(duplicate.code).toBe(2);
    expect(failureOf(duplicate)["code"]).toBe("invalid_request");

    // A stored tree that no longer matches its manifest is the store's
    // integrity, not the caller's input, so it earns a different code and a
    // different exit code.
    await writeFile(
      path.join(store, "acme-dashboard", "1.2.0", "files", "src", "main.cc"),
      "//x\n",
    );
    const tampered = await run(["template", "get", "acme-dashboard@1.2.0", "--json"], env);
    expect(tampered.code).toBe(1);
    expect(failureOf(tampered)["code"]).toBe("artifact_modified");
  });

  it("carries a malformed package's problems in the error contract", async () => {
    const root = await temporaryRoot();
    const fixture = await makeTemplatePackage({
      root,
      overrides: { schema: "uvp.template/2" },
    });
    const result = await run(["template", "validate", fixture.dir, "--json"], {
      UVP_TEMPLATE_HOME: path.join(root, "store"),
    });
    expect(result.code).toBe(2);
    const failure = failureOf(result);
    expect(failure["code"]).toBe("invalid_request");
    const details = failure["details"] as { problems?: readonly unknown[] } | undefined;
    expect((details?.problems ?? []).length).toBeGreaterThan(0);
  });
});
