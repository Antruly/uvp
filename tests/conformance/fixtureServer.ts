import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { freePort } from "../support/ports.js";

/**
 * Starting and stopping the conformance target.
 *
 * Two ways to get a port, and both are needed. `freePort`, in `tests/support/`,
 * reserves a number so a *child* process can be told where to listen before it
 * starts — which is what `uvp_run` needs, since its readiness probe is aimed at
 * the port before the binary exists. `startFixture` runs the fixture in-process
 * for the web tools, which need a target that is already up.
 */

export const FIXTURE_SCRIPT = fileURLToPath(
  new URL("./fixtures/fixtureServer.mjs", import.meta.url),
);

export interface FixtureServer {
  readonly port: number;
  readonly origin: string;
  stop(): Promise<void>;
  /**
   * How the fixture process is leaving, or has left, and the last thing it said.
   *
   * For a failure that has to know whether the target was still there. Both other
   * ends of this lane are in-process — the proxy and the client — and this one is
   * a child, whose exit and output no lane here read after startup. A `socket hang
   * up` from a loopback target is a peer that closed a socket under a request, so
   * which peer it was is the first question, and this is the only end that can
   * answer it.
   */
  state(): string;
}

/** Run the fixture for the duration of a test, on a reserved port. */
export const startFixture = async (): Promise<FixtureServer> => {
  const port = await freePort();
  const child = spawn(process.execPath, [FIXTURE_SCRIPT, String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FIXTURE_PORT: String(port) },
  });

  /**
   * What the child has said since it started, capped.
   *
   * Kept rather than drained and dropped, and drained at all: a piped stream with
   * no reader fills its pipe and blocks the child on its next write, and this is
   * the stream a fixture that has gone wrong would be writing to.
   */
  const said: string[] = [];
  const remember = (chunk: string): void => {
    said.push(chunk);
    if (said.length > 20) said.shift();
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", remember);
  child.stderr.on("data", remember);

  /** Set once, by whichever came: a normal exit or a signal. */
  let left: string | undefined;
  child.once("exit", (code, signal) => {
    left = signal === null ? `exited with code ${String(code)}` : `killed by ${String(signal)}`;
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("the fixture did not start within 10s")),
      10_000,
    );
    const settle = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on("data", (chunk: string) => {
      if (chunk.includes("fixture listening")) settle();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the fixture exited during startup with code ${String(code)}`));
    });
    child.once("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
  });

  return {
    port,
    origin: `http://127.0.0.1:${String(port)}`,
    state: () => {
      const lines = said
        .join("")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      const last = lines.at(-1);
      // Truncated with a count rather than silently: this goes into a failure's
      // output, and a half-line that looks whole is worse than a marked one.
      const detail =
        last === undefined
          ? ""
          : `, last said ${JSON.stringify(last.length > 200 ? `${last.slice(0, 200)}…` : last)}`;
      return `${left ?? "running"}${detail}`;
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      // The fixture closes its listener and exits, but a socket held open by a
      // failed test would keep it alive; kill it rather than hang the suite.
      const deadline = setTimeout(() => child.kill("SIGKILL"), 3_000);
      await exited;
      clearTimeout(deadline);
    },
  };
};

/**
 * The fixture, installed as a workspace's built binary.
 *
 * `writeFakeService` in `./fakeToolchain.ts` is what puts it where `uvp_run`
 * looks for one — `<workspace>/build/<manifest.binary>` — so launching it goes
 * through exactly the path a compiled service does: spawn, supervise, probe the
 * port, report. The port arrives as the program's first argument, which the
 * launcher passes because the fixture's own arguments are the caller's; that is
 * also what makes the same installation work on a host whose programs are not
 * shell scripts. See `tests/support/fakeExecutable.ts`.
 */
