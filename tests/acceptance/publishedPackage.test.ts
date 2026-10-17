import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXIT_OK, EXIT_WRONG } from "../../src/cli/exitCodes.js";
import { TOOL_CONTRACTS } from "../../src/contracts/toolContracts.js";
import { freePort, portAnswers } from "../support/ports.js";
import { realLibuvcpp, skipReason as libuvcppSkipReason } from "../support/realLibuvcpp.js";
import { removeTree } from "../support/temporaryTree.js";

/**
 * The clean-environment acceptance: install the published package and use it.
 *
 * Every other lane runs the checkout. A checkout has `node_modules`, a `dist/`
 * built a moment ago, and `scripts/uvp.mjs` resolving files by paths that exist
 * because it is the repository they are in. The published tarball has none of
 * that, and the difference is where a packaging mistake lives: a file `files[]`
 * forgot, an entry point that reaches outside the package, a version that
 * disagrees with the one the registry serves.
 *
 * This lane therefore installs `uvp-agents` from the registry into an isolated
 * prefix and drives *that* copy: `setup`, the MCP handshake, and — when a real
 * libuvcpp is found — generate → build → verify.
 *
 * ## Why it is opt-in, and what a skip means
 *
 * It contacts `registry.npmjs.org` and installs a released tarball, and its
 * build case compiles C++. Neither belongs in a lane every pull request runs. So
 * the lane runs only when `UVP_ACCEPTANCE_PUBLISHED` names a version (`0.2.0`,
 * or `latest`), and otherwise says in its title that it skipped and why. That
 * skip is not a claim about the package; it is this run saying it did not look.
 *
 * An install that fails is a **failure**, not a skip: "the version is not on the
 * registry" is exactly the fact this lane exists to establish. The build case is
 * the opposite — a host without libuvcpp cannot be asked, so it skips with the
 * discovery's own reason rather than reporting the package as broken.
 */

const promisified = promisify(execFile);

/** The version to install. Unset means the lane did not run. */
const REQUESTED = process.env["UVP_ACCEPTANCE_PUBLISHED"];

const SCRATCH = realpathSync(tmpdir());
const root = join(SCRATCH, `uvp-published-${String(process.pid)}`);
const prefix = join(root, "prefix");
const home = join(root, "home");
const work = join(root, "work");

/** Long enough for a cold `npm install` of five packages. */
const INSTALL_TIMEOUT_MS = 180_000;
/** A CMake configure, a compile, a launch, and one request. */
const BUILD_TIMEOUT_MS = 600_000;
const RPC_TIMEOUT_MS = 30_000;

interface Observation {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The installed package's own entry point — `bin.uvp`, from the tarball. */
const installedEntry = (): string =>
  join(prefix, "node_modules", "uvp-agents", "scripts", "uvp.mjs");

const childEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  // An isolated home and cache, so this lane cannot read a global uvp config or
  // reuse a cache entry that makes a cold install look warm.
  HOME: home,
  npm_config_cache: join(root, "npm-cache"),
});

const run = async (
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<Observation> => {
  try {
    const { stdout, stderr } = await promisified(command, [...args], {
      cwd: work,
      env: childEnvironment(),
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { exit: EXIT_OK, stdout, stderr };
  } catch (cause) {
    const failure = cause as { code?: unknown; stdout?: string; stderr?: string; message: string };
    if (typeof failure.code !== "number") {
      throw new Error(`${command} ${args.join(" ")} did not exit: ${failure.message}`);
    }
    return { exit: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

/** `uvp` from the installed package, which is the subject of this lane. */
const uvp = async (args: readonly string[], timeoutMs = INSTALL_TIMEOUT_MS): Promise<Observation> =>
  await run(process.execPath, [installedEntry(), ...args], timeoutMs);

const soleJson = (text: string, where: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${where} is not one JSON value: ${JSON.stringify(text.slice(0, 200))}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${where} is JSON but not an object: ${JSON.stringify(text.slice(0, 200))}`);
  }
  return parsed as Record<string, unknown>;
};

const OPT_IN_WHY =
  "opt-in: set UVP_ACCEPTANCE_PUBLISHED=<version> (or latest) to install the registry " +
  "package and drive it; this lane contacts registry.npmjs.org and compiles C++";

const SKIP: string | undefined =
  REQUESTED === undefined || REQUESTED.trim() === "" ? OPT_IN_WHY : undefined;

/**
 * Whether the build case can run here.
 *
 * The host's libuvcpp is a property of the machine rather than of the package,
 * so a missing one is a skip with the discovery's own reason — the same reason
 * the other acceptance lanes print — and never a red line about the release.
 */
const BUILD_SKIP: string | undefined = realLibuvcpp === undefined ? libuvcppSkipReason : undefined;

/**
 * The version the installed manifest reports, filled in once the install
 * succeeded.
 *
 * The other cases assert against it rather than against `REQUESTED`, because
 * `latest` is a moving name: what the run must be internally consistent about is
 * the version that was actually installed.
 */
let installedVersion = "";

/** The MCP session's child, so teardown can end a session that stopped answering. */
let liveChild: ChildProcessWithoutNullStreams | undefined;

beforeAll(async () => {
  if (SKIP !== undefined) return;
  mkdirSync(prefix, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });

  const spec = REQUESTED === "latest" ? "uvp-agents" : `uvp-agents@${REQUESTED ?? ""}`;
  const install = await run(
    "npm",
    ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", spec],
    INSTALL_TIMEOUT_MS,
  );
  if (install.exit !== 0) {
    throw new Error(
      `npm install ${spec} failed with exit ${String(install.exit)}. This is the fact the lane ` +
        `exists to check, so it is a failure rather than a skip.\n` +
        `stdout:\n${install.stdout}\nstderr:\n${install.stderr}`,
    );
  }

  const manifest = JSON.parse(
    await readFile(join(prefix, "node_modules", "uvp-agents", "package.json"), "utf8"),
  ) as { readonly name: string; readonly version: string };
  expect(manifest.name).toBe("uvp-agents");
  installedVersion = manifest.version;
});

afterAll(async () => {
  liveChild?.kill();
  if (SKIP !== undefined) return;
  await removeTree(root);
});

describe.skipIf(SKIP !== undefined)(
  SKIP === undefined
    ? `the published package${REQUESTED === "latest" ? " (latest)" : `@${String(REQUESTED)}`}`
    : `the published package — skipped: ${String(SKIP)}`,
  () => {
    it("installs the release and reports the version the registry served", () => {
      // The install ran in `beforeAll`; what is left is that it delivered the
      // entry point `bin.uvp` names and the version everything else asserts on.
      expect(installedVersion).toMatch(/^\d+\.\d+\.\d+/u);
      if (REQUESTED !== "latest") expect(installedVersion).toBe(REQUESTED);
      expect(readFileSync(installedEntry(), "utf8")).toContain("#!/usr/bin/env node");
    });

    it("prints a configuration that pins the installed version and the registry name", async () => {
      const printed = await uvp(["setup"]);
      expect(printed.exit).toBe(EXIT_OK);
      const config = soleJson(printed.stdout, "uvp setup stdout");
      const servers = config["mcpServers"] as Record<string, Record<string, unknown>>;
      expect(Object.keys(servers)).toEqual(["io.github.Antruly/uvp"]);
      expect(servers["io.github.Antruly/uvp"]).toEqual({
        command: "npx",
        args: ["-y", `uvp-agents@${installedVersion}`, "mcp"],
        type: "stdio",
      });
    });

    it("merges into a client config and leaves no copy of the bytes it replaced", async () => {
      const target = join(work, "existing.json");
      writeFileSync(
        target,
        `${JSON.stringify(
          { theme: "dark", mcpServers: { "other-server": { command: "other", args: ["serve"] } } },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const written = await uvp(["setup", "--write", "--path", target]);
      expect(written.exit).toBe(EXIT_OK);

      const merged = soleJson(readFileSync(target, "utf8"), target);
      expect(merged["theme"]).toBe("dark");
      const servers = merged["mcpServers"] as Record<string, Record<string, unknown>>;
      expect(servers["other-server"]).toEqual({ command: "other", args: ["serve"] });
      expect(servers["io.github.Antruly/uvp"]).toEqual({
        command: "npx",
        args: ["-y", `uvp-agents@${installedVersion}`, "mcp"],
        type: "stdio",
      });
      // Observed, and reported as a finding rather than promised: `--write` keeps
      // the parts of a config it does not own by merging, not by writing a copy
      // of the file. A user who wants to undo the change has what they wrote,
      // not a backup uvp made.
      expect(readdirSync(work).filter((name) => name.startsWith("existing"))).toEqual([
        "existing.json",
      ]);
    });

    it("refuses a config it could not parse and leaves its bytes exactly as they were", async () => {
      const target = join(work, "broken.json");
      const original = '{ "mcpServers": { "other": { "command": "x" }, } }\n';
      writeFileSync(target, original, "utf8");

      const refused = await uvp(["setup", "--write", "--path", target, "--json"]);
      expect(refused.exit).toBe(EXIT_WRONG);
      expect(readFileSync(target, "utf8")).toBe(original);
      const failure = soleJson(refused.stderr, "uvp setup stderr");
      expect(failure["code"]).toBe("invalid_request");
      expect(String(failure["message"])).toContain(target);
    });

    it(
      "serves the shipped catalog over MCP and answers uvp_doctor",
      async () => {
        const session = spawnSession();
        try {
          const initialized = await session.request("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "uvp-acceptance", version: "0.0.0" },
          });
          const serverInfo = initialized["serverInfo"] as Record<string, unknown>;
          expect(serverInfo["name"]).toBe("io.github.Antruly/uvp");
          expect(serverInfo["version"]).toBe(installedVersion);

          const listed = await session.request("tools/list", {});
          const tools = listed["tools"] as { readonly name: string }[];
          // What the installed package advertises is the contract catalog, in
          // order. A tool missing here is a tool a user of the release does not
          // have, whatever the checkout says.
          expect(tools.map((tool) => tool.name)).toEqual(
            TOOL_CONTRACTS.map((contract) => contract.name),
          );

          const doctor = await session.request("tools/call", {
            name: "uvp_doctor",
            arguments: {},
          });
          expect(doctor["isError"]).not.toBe(true);
          expect(doctor["structuredContent"]).toBeTypeOf("object");
        } finally {
          await session.close();
        }
      },
      RPC_TIMEOUT_MS * 4,
    );

    it.skipIf(BUILD_SKIP !== undefined)(
      BUILD_SKIP === undefined
        ? "generates, builds, and verifies a service with the installed copy"
        : `generates, builds, and verifies a service with the installed copy — skipped: ${BUILD_SKIP}`,
      async () => {
        const doctor = await uvp(["doctor", "--json"]);
        expect(doctor.exit).toBe(EXIT_OK);
        const report = soleJson(doctor.stdout, "uvp doctor --json stdout");
        // The discovery that gated this case ran the checkout's CLI; the
        // installed copy is asked again, because the release is what a user runs.
        expect((report["libuvcpp"] as Record<string, unknown> | undefined)?.["found"]).toBe(true);

        const port = await freePort();
        const generated = await uvp([
          "init",
          "./svc",
          "--name",
          "svc",
          "--template",
          "hello-http",
          "--port",
          String(port),
        ]);
        expect(generated.exit).toBe(EXIT_OK);
        expect(readFileSync(join(work, "svc", "src", "main.cpp"), "utf8")).toContain("/hello");

        const built = await uvp(["build", "./svc"], BUILD_TIMEOUT_MS);
        expect(built.exit).toBe(EXIT_OK);

        const verified = await uvp(
          [
            "verify",
            "./svc",
            "--port",
            String(port),
            "--request",
            "GET",
            "/hello",
            "--assert",
            "status=200",
            "--goal",
            "a clean-environment install reaches a verified service",
            "--json",
          ],
          BUILD_TIMEOUT_MS,
        );
        expect(verified.exit).toBe(EXIT_OK);
        const result = soleJson(verified.stdout, "uvp verify --json stdout");
        expect(result["status"]).toBe("verified");
        // `uvp verify` stops the service it started; the port is the claim, not
        // the report's own sentence about it.
        expect(await portAnswers(port, 2_000)).toBe(false);
      },
      BUILD_TIMEOUT_MS,
    );
  },
);

interface Session {
  request(method: string, params?: unknown): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * The MCP session over the installed package's stdio.
 *
 * The same shape the boundary lane uses, and for the same reason: what a client
 * depends on is that stdout carries protocol frames and nothing else, so a line
 * that does not parse fails the request rather than being stepped over.
 */
const spawnSession = (): Session => {
  const child = spawn(process.execPath, [installedEntry(), "mcp"], {
    cwd: work,
    env: childEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  liveChild = child;

  const waiting = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (cause: Error) => void }
  >();
  let nextId = 1;
  let stderr = "";

  const fail = (cause: Error): void => {
    const held = [...waiting.values()];
    waiting.clear();
    for (const entry of held) entry.reject(cause);
  };

  createInterface({ input: child.stdout }).on("line", (line) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      fail(new Error(`stdout carried a line that is not a JSON-RPC frame: ${line}`));
      return;
    }
    const id = frame["id"];
    if (typeof id !== "number") return;
    const entry = waiting.get(id);
    if (entry === undefined) return;
    waiting.delete(id);
    const error = frame["error"] as Record<string, unknown> | undefined;
    if (error !== undefined) {
      entry.reject(new Error(`JSON-RPC error ${JSON.stringify(error)}`));
      return;
    }
    entry.resolve((frame["result"] ?? {}) as Record<string, unknown>);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(
            new Error(
              `${method} was not answered within ${String(RPC_TIMEOUT_MS)} ms; stderr: ${stderr}`,
            ),
          );
        }, RPC_TIMEOUT_MS);
        waiting.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (cause) => {
            clearTimeout(timer);
            reject(cause);
          },
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`,
        );
      }),
    close: async () => {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });
    },
  };
};
