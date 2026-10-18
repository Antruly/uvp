import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

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

  it("generates a workspace from an imported package", async () => {
    const root = await temporaryRoot();
    const store = path.join(root, "store");
    const env = { UVP_TEMPLATE_HOME: store };
    const fixture = await makeTemplatePackage({
      root,
      content: "// {{project.name}} {{project.port}} {{features}}\nint main() { return 0; }\n",
      overrides: {
        requires: { features: ["websocket"] },
        routes: ["GET /hello"],
      },
    });
    const imported = await run(["template", "import", fixture.dir, "--json"], env);
    expect(imported.code).toBe(0);

    const workspace = path.join(root, "ws");
    const init = await run(
      ["init", workspace, "--name", "acme", "--template-package", "acme-dashboard@1.2.0", "--json"],
      env,
    );
    expect(init.code, init.stderr).toBe(0);
    const output = json(init);
    expect(output["template"]).toBe("acme-dashboard");
    expect(output["template_package"]).toMatchObject({
      id: "acme-dashboard",
      version: "1.2.0",
    });
    expect(output["routes"]).toEqual(["GET /hello"]);

    const rendered = await readFile(path.join(workspace, "src", "main.cc"), "utf8");
    expect(rendered).toContain("// acme 8080 websocket");

    const manifest = JSON.parse(await readFile(path.join(workspace, "uvp.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const templatePackage = manifest["template_package"] as Record<string, unknown>;
    expect(templatePackage["id"]).toBe("acme-dashboard");
    expect(templatePackage["version"]).toBe("1.2.0");
    expect(manifest["features"]).toEqual(["websocket"]);
    expect(manifest["scheme"]).toBe("http");
  });

  it("refuses both a built-in template and a template package", async () => {
    const root = await temporaryRoot();
    const result = await run(
      [
        "init",
        path.join(root, "ws"),
        "--name",
        "acme",
        "--template",
        "hello-http",
        "--template-package",
        "acme-dashboard@1.2.0",
      ],
      { UVP_TEMPLATE_HOME: path.join(root, "store") },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("both name a source");
  });
});
