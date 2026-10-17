import { describe, expect, it } from "vitest";

import { cancelledFailure, isCancelledFailure } from "../domain/errors.js";
import type { SessionStore } from "./sessionStore.js";
import type { BuildRequest, ToolchainIdentity } from "./ToolchainProvider.js";
import { verify, type VerifyContext, type VerifyInput } from "./VerificationService.js";
import type { WebService } from "./WebService.js";
import type { WorkspaceService } from "./WorkspaceService.js";

/**
 * What a verification pass does when the caller withdraws.
 *
 * The readiness stage in this file already rethrows a cancellation rather than
 * answering it; the request stage did not. It received the cancellation through
 * the same catch as every transport failure, recorded it as an `unverified`
 * entry whose own sentence said the request completed, and then issued the next
 * request after the caller had stopped waiting.
 *
 * The doubles here are deliberate: the question is who owns the loop and the
 * record, not what a socket does. The transport's own cancellation is held by
 * `httpClient.test.ts`, and the whole path is exercised in the conformance lane.
 */

const identity: ToolchainIdentity = { id: "double", version: "1.0.0", platform: "linux-x64" };

const input: VerifyInput = {
  path: "/nonexistent/uvp-verify-cancellation",
  build: { build_type: "Debug" },
  run: { port: 65500, ready_path: "/healthz", timeout_ms: 1_000, args: [] },
  requests: [
    {
      name: "first",
      method: "GET",
      path: "/slow",
      headers: {},
      body: undefined,
      http_version: "auto",
      assertions: [],
    },
    {
      name: "second",
      method: "GET",
      path: "/hello",
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

const workspace: WorkspaceService = {
  build: async (request: BuildRequest) => ({
    workspaceId: "wsp_test",
    outcome: {
      buildDir: request.buildDir ?? "/nonexistent/build",
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
    runId: "run_test",
    workspaceId: "wsp_test",
    command: "/bin/true",
    args: [],
    pid: 1,
    ready: true,
    endpoint: "http://127.0.0.1:65500",
    startupMs: 1,
    stdoutTail: "",
    stderrTail: "",
    stillRunning: true,
    detached: true,
  }),
} as unknown as WorkspaceService;

const store: SessionStore = { exchange: () => undefined } as unknown as SessionStore;

/**
 * A web port whose first request stays in flight until the caller withdraws.
 *
 * It counts the requests it was asked for, which is the half of the defect a
 * rejection alone would not establish: the pass that kept going issued the
 * second request after the first had been cancelled.
 */
const webOf = (
  controller: AbortController,
): { readonly web: WebService; readonly issued: () => number } => {
  let issued = 0;
  const web = {
    httpRequest: async (_input: unknown, _recorder: unknown, signal: AbortSignal) => {
      issued += 1;
      // Mirror the transport: an already-aborted signal rejects at once, and a
      // withdrawal while the request is in flight rejects it with the same
      // failure the layers above treat as a cancellation.
      return await new Promise((_resolve, reject) => {
        const cancel = (): void => {
          reject(cancelledFailure("The request was cancelled before a response was read."));
        };
        if (signal.aborted) {
          cancel();
          return;
        }
        signal.addEventListener("abort", cancel, { once: true });
      });
    },
  } as unknown as WebService;
  return { web, issued: () => issued };
};

const settled = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

describe("a verification pass the caller stops mid-request", () => {
  it("rejects with a cancellation and issues no further request", async () => {
    const controller = new AbortController();
    const { web, issued } = webOf(controller);
    const context: VerifyContext = {
      workspace,
      web,
      store,
      identity,
      now: () => new Date("2026-10-17T00:00:00.000Z"),
      signal: controller.signal,
    };

    const pending = verify(input, context);
    setTimeout(() => {
      controller.abort();
    }, 10).unref();

    const failure = await settled(pending);

    // A resolved bundle here would be the defect wearing either face: it would
    // carry an `unverified` entry for a request the caller had stopped waiting
    // for, and its own sentence would say the request completed.
    expect(isCancelledFailure(failure)).toBe(true);
    expect(issued()).toBe(1);
  });

  it("issues nothing for a signal that was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { web, issued } = webOf(controller);
    const context: VerifyContext = {
      workspace,
      web,
      store,
      identity,
      now: () => new Date("2026-10-17T00:00:00.000Z"),
      signal: controller.signal,
    };

    const failure = await settled(verify(input, context));

    expect(isCancelledFailure(failure)).toBe(true);
    expect(issued()).toBe(0);
  });
});
