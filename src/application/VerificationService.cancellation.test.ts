import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verify } from "./VerificationService.js";
import type { VerifyContext, VerifyInput } from "./VerificationService.js";
import type { WebService } from "./WebService.js";
import type { WorkspaceService } from "./WorkspaceService.js";
import { cancelledFailure, toUvpError } from "../domain/errors.js";
import { SessionStore } from "./sessionStore.js";

/**
 * The invariant a withdrawal has to keep, timed without a race.
 *
 * The conformance case covers the whole path through a real request against the
 * fixture, but it depends on the abort landing while that request is in flight.
 * Here the withdrawal is raised by the web double itself, so it happens exactly
 * once while the first request is outstanding: the pass must reject as
 * `cancelled` and must not put the second request. An already-aborted signal
 * must put none at all.
 */

const NOW = (): Date => new Date("2026-10-17T00:00:00.000Z");
const WORKSPACE_ID = "wsp_0123456789abcdefabcdef";
const RUN_ID = "run_0123456789abcdefabcdef";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "uvp-verify-cancel-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const contextFor = (controller: AbortController, counts: { requests: number }): VerifyContext => {
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
    stop: async () => ({ stopped: [], cleanupComplete: true }),
  } as unknown as WorkspaceService;

  const web = {
    httpRequest: async () => {
      counts.requests += 1;
      // The first request is the one that is in flight when the caller leaves.
      // Raising the abort here makes the timing a property of the fixture rather
      // than of the machine.
      if (counts.requests === 1) controller.abort();
      if (!controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      // The shape the real service throws: the transport hands a withdrawal back
      // as the typed cancellation rather than as a transport finding.
      throw cancelledFailure("The request was cancelled while it was in flight.");
    },
  } as unknown as WebService;

  return {
    workspace,
    web,
    store: new SessionStore(NOW),
    identity: { id: "local", platform: "linux-x64" },
    now: NOW,
    signal: controller.signal,
  };
};

const input: VerifyInput = {
  path: "",
  build: { build_type: "Debug" },
  run: { port: 8080, ready_path: "/healthz", timeout_ms: 5_000, args: [] },
  requests: [
    {
      name: "first",
      method: "GET",
      path: "/",
      headers: {},
      body: undefined,
      http_version: "auto",
      assertions: [],
    },
    {
      name: "second",
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

describe("a verification pass the caller withdrew from", () => {
  it("rejects as cancelled and sends no request after the one in flight", async () => {
    const controller = new AbortController();
    const counts = { requests: 0 };

    const failure = await verify({ ...input, path: root }, contextFor(controller, counts)).then(
      () => undefined,
      (cause: unknown) => toUvpError(cause),
    );

    expect(failure?.code).toBe("cancelled");
    expect(counts.requests).toBe(1);
  });

  it("sends nothing when the signal had already been aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const counts = { requests: 0 };

    const failure = await verify({ ...input, path: root }, contextFor(controller, counts)).then(
      () => undefined,
      (cause: unknown) => toUvpError(cause),
    );

    expect(failure?.code).toBe("cancelled");
    expect(counts.requests).toBe(0);
  });
});
