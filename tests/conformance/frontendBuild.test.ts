import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { FrontendBuildService } from "../../src/application/FrontendBuildService.js";
import { runProcess } from "../../src/toolchains/processRunner.js";

/**
 * The frontend build against real processes.
 *
 * Every other frontend-build test uses a scripted runner, which is right for
 * sequencing and classification: those are about what uvp does with an answer.
 * They cannot show that the answers arrive as modelled, because a fake that
 * returns an outcome has already assumed the property under test. This lane
 * uses the real `runProcess` and the real `node` and `npm`: the workspace has
 * no dependencies, so `npm ci` is an offline lockfile install, and the build
 * script is a local file — no network, no compiler, no libuvcpp.
 *
 * The Node-absent lane hides the host's Node by replacing the child's `PATH`
 * with an empty directory. That is the real boundary: `spawn` fails with ENOENT
 * and the tool must report a missing prerequisite rather than a failed build.
 * It is skipped on Windows, where CreateProcess can find an executable outside
 * `PATH` and the experiment would not establish absence.
 */

const probe = (command: string): boolean => {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 10_000 });
  return result.status === 0;
};

const NODE_SKIP = probe("node") ? undefined : "no `node` on PATH in this environment";
const NPM_SKIP = probe("npm") ? undefined : "no `npm` on PATH in this environment";
const PRESENT_SKIP = NODE_SKIP ?? NPM_SKIP;
const ABSENT_SKIP =
  process.platform === "win32"
    ? "Windows can find an executable outside PATH, so hiding Node would not establish its absence"
    : undefined;

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/**
 * A workspace whose frontend has no dependencies and whose build is a local
 * script, so the lane exercises npm without the registry.
 */
const minimalWorkspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "uvp-frontend-real-"));
  roots.push(root);
  await writeFile(join(root, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\n");
  await writeFile(
    join(root, "uvp.json"),
    JSON.stringify({ name: "real", frontends: ["vue3"] }, null, 2),
  );
  await mkdir(join(root, "frontend"), { recursive: true });
  await writeFile(
    join(root, "frontend", "package.json"),
    JSON.stringify(
      {
        name: "real-frontend",
        version: "1.0.0",
        private: true,
        scripts: { build: "node build.js" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(root, "frontend", "package-lock.json"),
    JSON.stringify(
      {
        name: "real-frontend",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "real-frontend", version: "1.0.0" } },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(root, "frontend", "build.js"),
    'const fs = require("node:fs");\n' +
      'fs.mkdirSync("dist", { recursive: true });\n' +
      'fs.writeFileSync("dist/index.html", "<!doctype html>\\n");\n',
  );
  return root;
};

describe.skipIf(PRESENT_SKIP !== undefined)(
  PRESENT_SKIP === undefined
    ? "the frontend build with the host's Node"
    : `the frontend build with the host's Node — skipped: ${String(PRESENT_SKIP)}`,
  () => {
    it("installs the lockfile and runs the project's build through the real runner", async () => {
      const root = await minimalWorkspace();
      const built = await new FrontendBuildService(runProcess).build({
        path: root,
        timeoutMs: 120_000,
        signal: new AbortController().signal,
      });

      expect(built.nodeVersion).toMatch(/^v\d+\./u);
      expect(built.npmVersion).toMatch(/^\d+\./u);
      expect(built.steps.map((step) => step.args[0])).toEqual(["ci", "run"]);
      expect(built.stepsSucceeded).toBe(true);
      expect(built.built).toBe(true);
      expect((await stat(built.entry)).isFile()).toBe(true);
    }, 60_000);
  },
);

describe.skipIf(ABSENT_SKIP !== undefined)(
  ABSENT_SKIP === undefined
    ? "the frontend build without Node"
    : `the frontend build without Node — skipped: ${String(ABSENT_SKIP)}`,
  () => {
    it("reports missing_requirement and starts no npm step", async () => {
      const root = await minimalWorkspace();
      const emptyPath = await mkdtemp(join(tmpdir(), "uvp-empty-path-"));
      roots.push(emptyPath);

      // The port carries the environment, so the experiment is a property of
      // this call rather than of the test process: nothing else in this worker
      // sees the narrowed PATH.
      const withoutNode = (request: Parameters<typeof runProcess>[0]) =>
        runProcess({ ...request, env: { PATH: emptyPath, Path: emptyPath } });

      await expect(
        new FrontendBuildService(withoutNode).build({
          path: root,
          timeoutMs: 60_000,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ detail: { code: "missing_requirement" } });

      // Nothing was installed and no framework build ran.
      await expect(stat(join(root, "frontend", "node_modules"))).rejects.toThrow();
      await expect(stat(join(root, "frontend", "dist"))).rejects.toThrow();
    }, 60_000);
  },
);
