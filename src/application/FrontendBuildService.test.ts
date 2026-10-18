import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommandOutcome, CommandRequest } from "./CommandRunner.js";
import { FrontendBuildService } from "./FrontendBuildService.js";

/**
 * The frontend build, driven by a fake command runner.
 *
 * The lane is about sequencing and classification: which commands run, in which
 * directory, and how an exit code becomes a result. A real npm run adds nothing
 * to those questions and would make this lane depend on the network.
 */

interface Recorded {
  readonly request: CommandRequest;
  readonly result: CommandOutcome;
}

const outcome = (patch: Partial<CommandOutcome> = {}): CommandOutcome => ({
  command: "node",
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  durationMs: 1,
  stdout: "",
  stderr: "",
  stdoutBytes: 0,
  stderrBytes: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...patch,
});

/**
 * A runner that answers per executable and records the calls.
 *
 * `onBuild` runs when `npm run build` is asked for, so a test can write the
 * entry file at the point the real build would have.
 */
const fakeRunner = (options: {
  readonly node?: () => Promise<CommandOutcome>;
  readonly npm?: (request: CommandRequest) => Promise<CommandOutcome>;
}): {
  readonly run: (request: CommandRequest) => Promise<CommandOutcome>;
  readonly calls: Recorded[];
} => {
  const calls: Recorded[] = [];
  return {
    calls,
    run: async (request) => {
      const result =
        request.command === "node"
          ? await (options.node?.() ?? Promise.resolve(outcome({ stdout: "v24.21.0\n" })))
          : request.args[0] === "--version"
            ? outcome({ stdout: "11.16.0\n" })
            : await (options.npm?.(request) ??
                Promise.resolve(outcome({ stdout: "added 35 packages\n" })));
      calls.push({ request, result });
      return result;
    },
  };
};

const buildCalls = (calls: readonly Recorded[]): Recorded[] =>
  calls.filter((call) => call.request.args[0] !== "--version");

describe("FrontendBuildService", () => {
  let root: string;

  const writeWorkspace = async (
    frontends: readonly string[],
    files: { readonly manifest?: boolean; readonly lockfile?: boolean } = {},
  ): Promise<void> => {
    root = await mkdtemp(join(tmpdir(), "uvp-frontend-build-"));
    await writeFile(join(root, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\n");
    await writeFile(join(root, "uvp.json"), JSON.stringify({ name: "svc", frontends }));
    await mkdir(join(root, "frontend"), { recursive: true });
    if (files.manifest ?? true) {
      await writeFile(
        join(root, "frontend", "package.json"),
        JSON.stringify({ name: "svc-frontend", private: true }),
      );
    }
    if (files.lockfile ?? true) {
      await writeFile(join(root, "frontend", "package-lock.json"), "{}\n");
    }
  };

  beforeEach(async () => {
    await writeWorkspace(["vue3"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const build = (runner: (request: CommandRequest) => Promise<CommandOutcome>) =>
    new FrontendBuildService(runner, { platform: "linux" }).build({
      path: root,
      timeoutMs: 60_000,
      signal: new AbortController().signal,
    });

  it("runs npm ci then npm run build in frontend/", async () => {
    const fake = fakeRunner({});
    const result = await build(fake.run);

    expect(fake.calls.map((call) => [call.request.command, call.request.args])).toEqual([
      ["node", ["--version"]],
      ["npm", ["--version"]],
      ["npm", ["ci", "--no-audit", "--no-fund"]],
      ["npm", ["run", "build"]],
    ]);
    for (const call of buildCalls(fake.calls)) {
      expect(call.request.cwd, call.request.command).toBe(join(root, "frontend"));
    }
    expect(result.frontend).toBe("vue3");
    expect(result.steps.map((step) => step.succeeded)).toEqual([true, true]);
    expect(result.stepsSucceeded).toBe(true);
  });

  it("reports built only from frontend/dist/index.html", async () => {
    const fake = fakeRunner({
      npm: async (request) => {
        if (request.args[0] === "run") {
          await mkdir(join(root, "frontend", "dist"), { recursive: true });
          await writeFile(join(root, "frontend", "dist", "index.html"), "<!doctype html>\n");
        }
        return outcome();
      },
    });
    const result = await build(fake.run);
    expect(result.built).toBe(true);
    expect(result.entry).toBe(join(root, "frontend", "dist", "index.html"));
  });

  it("stops after a failing install and never starts the framework build", async () => {
    const fake = fakeRunner({
      npm: async (request) =>
        request.args[0] === "ci"
          ? outcome({ exitCode: 1, stderr: "npm ERR! network\n" })
          : outcome(),
    });
    const result = await build(fake.run);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.stderrTail).toContain("npm ERR! network");
    expect(result.stepsSucceeded).toBe(false);
    expect(result.built).toBe(false);
  });

  it("does not claim a build when dist/index.html is absent", async () => {
    const result = await build(fakeRunner({}).run);
    expect(result.stepsSucceeded).toBe(true);
    expect(result.built).toBe(false);
  });

  it("refuses a workspace without a Node frontend app", async () => {
    await writeWorkspace(["h5-tech"]);
    const fake = fakeRunner({});
    await expect(build(fake.run)).rejects.toMatchObject({ detail: { code: "invalid_request" } });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a path that is not a workspace", async () => {
    const fake = fakeRunner({});
    await expect(
      new FrontendBuildService(fake.run, { platform: "linux" }).build({
        path: join(root, "missing"),
        timeoutMs: 1_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ detail: { code: "workspace_not_found" } });
  });

  it("refuses a project without its committed lockfile before spawning anything", async () => {
    await writeWorkspace(["react"], { lockfile: false });
    const fake = fakeRunner({});
    await expect(build(fake.run)).rejects.toMatchObject({ detail: { code: "invalid_request" } });
    expect(fake.calls).toHaveLength(0);
  });

  it("reports an absent node as a missing requirement, not a failed build", async () => {
    const fake = fakeRunner({
      node: () => Promise.reject(Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" })),
    });
    await expect(build(fake.run)).rejects.toMatchObject({
      detail: {
        code: "missing_requirement",
        remediation: { docs: "docs/installation.md" },
      },
    });
    expect(buildCalls(fake.calls)).toHaveLength(0);
  });

  it("treats a probe that cannot answer as a missing requirement", async () => {
    const fake = fakeRunner({
      node: () => Promise.resolve(outcome({ exitCode: 127, stderr: "not found\n" })),
    });
    await expect(build(fake.run)).rejects.toMatchObject({
      detail: { code: "missing_requirement" },
    });
  });

  it("reports the caller's withdrawal as cancelled, not as a failed build", async () => {
    const fake = fakeRunner({
      npm: async (request) => outcome({ aborted: request.args[0] === "ci", exitCode: null }),
    });
    await expect(build(fake.run)).rejects.toMatchObject({ detail: { code: "cancelled" } });
  });

  it("uses npm.cmd through the shell on Windows", async () => {
    const fake = fakeRunner({});
    await new FrontendBuildService(fake.run, { platform: "win32" }).build({
      path: root,
      timeoutMs: 60_000,
      signal: new AbortController().signal,
    });
    const npmCalls = fake.calls.filter((call) => call.request.command === "npm.cmd");
    expect(npmCalls.map((call) => call.request.shell)).toEqual([true, true, true]);
  });
});
