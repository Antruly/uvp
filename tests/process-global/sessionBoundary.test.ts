import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createRecorder } from "../../src/application/evidenceHelpers.js";
import { runCli } from "../../src/cli.js";
import { EXIT_OK } from "../../src/cli/exitCodes.js";
import type { OutputStreams } from "../../src/cli/output.js";
import { createUvpServices } from "../../src/composition/uvpServices.js";

/**
 * Whose session it is.
 *
 * uvp reports what *this session* has seen: the runs it supervises, the exchanges
 * it made, the evidence behind a result. `createUvpServices` is called once per
 * caller and the store it builds belongs to that graph, not to the module.
 *
 * The distinction is invisible until two callers share a process, which is
 * precisely what an MCP server is — one process, one graph per session, several
 * conversations at once. Were the store module-level, a plausible "it is only a
 * cache, reuse it" change, then `uvp stop --all` in one session would kill
 * another session's services, and one caller's HTTP exchanges would show up in
 * another's evidence bundle. Neither failure errors. The numbers are simply
 * wrong, about someone else, and in this project that is the worst kind of wrong:
 * a claim about an observation that the reader has no way to attribute.
 *
 * Two graphs, and the same two questions asked of each. The runs half needs a
 * real process to supervise — a child that is alive is the only thing that makes
 * "the other session saw nothing" mean anything — so it runs a two-line shell
 * script rather than a generated service. The service itself is not the subject
 * here; ownership of the registration is.
 */

const SCRATCH = mkdtempSync(join(realpathSync(tmpdir()), "uvp-process-global-"));

// The manifest names the binary, and the binary sleeps: `WorkspaceService.run`
// supervises whatever `build/<binary>` is, and a service that exited immediately
// would be out of the registry before the second session could look for it.
mkdirSync(join(SCRATCH, "build"), { recursive: true });
writeFileSync(join(SCRATCH, "uvp.json"), `${JSON.stringify({ name: "svc", binary: "svc" })}\n`);
writeFileSync(join(SCRATCH, "build", "svc"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });

/** Whether the operating system still has this pid. */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface Captured {
  readonly streams: OutputStreams;
  /** The JSON result the CLI printed, parsed. */
  readonly result: () => Record<string, unknown>;
}

/**
 * Streams that keep what they were given.
 *
 * Reading the result back out of a stream rather than out of a handler's return
 * value is the point: `stopped: []` below is what *another session* would tell a
 * person who typed the command, not an internal detail of the graph.
 */
const captured = (): Captured => {
  const lines: string[] = [];
  return {
    streams: { out: (text) => lines.push(text), err: (text) => lines.push(text) },
    result: () => JSON.parse(lines.join("")) as Record<string, unknown>,
  };
};

/** A server that answers anything with one small JSON body. */
const startAnswering = async (): Promise<{ readonly server: Server; readonly port: number }> => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server did not report a numeric port");
  }
  return { server, port: address.port };
};

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("a session", () => {
  it("supervises the runs its own graph started, and no others", async () => {
    const mine = createUvpServices();
    const theirs = createUvpServices();

    const run = await mine.workspace.run({ path: SCRATCH, args: [], env: {}, detach: true });
    expect(run.detached).toBe(true);
    expect(run.stillRunning).toBe(true);
    const pid = run.pid;
    if (pid === undefined) throw new Error("the run reported no pid");
    expect(isAlive(pid)).toBe(true);

    try {
      // The other session's answer to `stop --all`. `stopped: []` is not "nothing
      // happened" — the run is right there, alive, in `mine` — it is this session
      // saying it has no such run. That is the safe answer: a registry shared
      // between sessions would let any caller kill any other caller's services.
      const stranger = captured();
      const strangerCode = await runCli(["stop", "--all", "--json"], {
        streams: stranger.streams,
        services: theirs,
      });

      expect(strangerCode).toBe(EXIT_OK);
      expect(stranger.result()["stopped"]).toEqual([]);
      expect(isAlive(pid), "another session's stop --all reached this session's run").toBe(true);

      // And the owner, whose answer is the run itself: found, stopped, and gone
      // from the operating system — not merely reported as stopped.
      const owner = captured();
      const ownerCode = await runCli(["stop", "--run-id", run.runId, "--json"], {
        streams: owner.streams,
        services: mine,
      });

      expect(ownerCode).toBe(EXIT_OK);
      const stopped = owner.result()["stopped"] as { run_id: string; outcome: string }[];
      expect(stopped.map((entry) => entry.run_id)).toEqual([run.runId]);
      expect(owner.result()["cleanup_complete"]).toBe(true);
      expect(isAlive(pid), "the session that owns the run could not stop it").toBe(false);
    } finally {
      // Hygiene, and only that: by here the run is either stopped or was never
      // anyone else's to stop.
      await mine.workspace.stop({ all: true, graceMs: 1_000, force: true });
    }
  });

  it("records the exchanges its own graph made, and counts no others", async () => {
    const mine = createUvpServices();
    const theirs = createUvpServices();
    const { server, port } = await startAnswering();

    try {
      const response = await mine.web.httpRequest(
        {
          url: `http://127.0.0.1:${String(port)}/`,
          method: "GET",
          headers: {},
          body: undefined,
          body_encoding: "utf8",
          http_version: "auto",
          follow_redirects: false,
          max_redirects: 0,
          verify_tls: true,
          timeout_ms: 5_000,
          max_body_bytes: 65_536,
        },
        createRecorder(),
        new AbortController().signal,
      );

      expect(response.status).toBe(200);

      // Recorded where it happened: the exchange is reachable by the id the
      // caller was handed, which is what makes an evidence bundle's citations
      // resolve.
      expect(mine.store.totalExchanges()).toBe(1);
      expect(mine.store.exchange(response.exchange_id)).toBeDefined();

      // And nowhere else. A shared store would make the second number one, and
      // the second session's bundle would carry a request it never made.
      expect(theirs.store.totalExchanges()).toBe(0);
      expect(theirs.store.exchange(response.exchange_id)).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
