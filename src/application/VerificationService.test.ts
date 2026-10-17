import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verify } from "./VerificationService.js";
import type { VerifyContext, VerifyInput } from "./VerificationService.js";
import type { WebService } from "./WebService.js";
import type { WorkspaceService } from "./WorkspaceService.js";
import { SessionStore } from "./sessionStore.js";

/**
 * What a pass says when it could not stop the service it started.
 *
 * Cleanup is reported, never inferred: a stop that returns `unresponsive` is a
 * service that may still be listening, and the result's limitations must say so
 * rather than claiming the process is gone. The unknown beside it already names
 * the same fact — the two used to disagree, which is the failure this test pins.
 */

const NOW = (): Date => new Date("2026-10-17T00:00:00.000Z");
const WORKSPACE_ID = "wsp_0123456789abcdefabcdef";
const RUN_ID = "run_0123456789abcdefabcdef";

let root: string;

beforeAll(async () => {
  // A directory with no `uvp.json`: verify treats an absent manifest as a
  // cleartext workspace, and this test is not about manifests.
  root = await mkdtemp(join(tmpdir(), "uvp-verify-cleanup-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const contextFor = (): VerifyContext => {
  const workspace = {
    build: async () => ({
      workspaceId: WORKSPACE_ID,
      outcome: {
        buildDir: join(root, "build"),
        exitCode: 0,
        succeeded: true,
        configureDurationMs: 1,
        compileDurationMs: 1,
        fromCache: false,
        diagnostics: [],
        artifacts: [],
        commands: [],
      },
    }),
    run: async () => ({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      command: join(root, "build", "svc"),
      args: [],
      pid: 4242,
      ready: true,
      endpoint: "http://127.0.0.1:8080/healthz",
      startupMs: 1,
      stdoutTail: "",
      stderrTail: "",
      stillRunning: true,
      detached: true,
    }),
    stop: async () => ({
      stopped: [
        {
          runId: RUN_ID,
          pid: 4242,
          exitCode: undefined,
          signal: undefined,
          killed: false,
          outcome: "unresponsive",
        },
      ],
      cleanupComplete: false,
    }),
  } as unknown as WorkspaceService;

  const web = {
    httpRequest: async () => ({
      exchange_id: "exchange_0123456789abcdefab",
      status: 200,
      http_version: "1.1",
      tls: undefined,
    }),
  } as unknown as WebService;

  return {
    workspace,
    web,
    store: new SessionStore(NOW),
    identity: { id: "local", platform: "linux-x64" },
    now: NOW,
    signal: new AbortController().signal,
  };
};

const input: VerifyInput = {
  path: "",
  build: { build_type: "Debug" },
  run: { port: 8080, ready_path: "/healthz", timeout_ms: 5_000, args: [] },
  requests: [
    {
      name: "ok",
      method: "GET",
      path: "/",
      headers: {},
      body: undefined,
      http_version: "auto",
      assertions: [],
    },
  ],
  keep_running: false,
  goal: undefined,
  toolchain: undefined,
  verify_tls: false,
};

describe("a pass whose stop failed", () => {
  it("says the service may still be listening instead of claiming it was stopped", async () => {
    const result = (await verify({ ...input, path: root }, contextFor())) as unknown as {
      limitations?: readonly string[];
      unknowns?: readonly { question: string; reason: string }[];
    };

    const limitations = (result.limitations ?? []).join("\n");
    expect(limitations).not.toContain("The service was stopped after the pass");
    expect(limitations).toContain("may still be listening");

    // The unknown was already recorded; the fix is that the prose agrees with it.
    expect(
      result.unknowns?.some(
        (unknown) => unknown.question === "Was the service stopped after the pass?",
      ),
    ).toBe(true);
  });
});
