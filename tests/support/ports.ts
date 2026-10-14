import { createServer } from "node:net";

/**
 * Port reservation, shared by the lanes that need a number before anything is
 * listening on it.
 *
 * Two lanes need this for opposite reasons. The conformance lane reserves a port
 * so a *child* process can be told where to listen before it starts — `uvp_run`
 * aims its readiness probe at the port before the binary exists. The CLI lane
 * needs a port that is free and *stays* free, because a connection refused is the
 * only way to reach some CLI states without a target.
 *
 * The reservation is a bind-then-release, so in principle another process can
 * take the number in the gap. The window is microseconds and the failure is a
 * clear `EADDRINUSE` or an unexpected success rather than a wrong answer, which
 * is the trade a test can afford; a fixed port number would instead collide with
 * whatever else is on the machine.
 *
 * A caller that needs the port to remain free should say so in the failure: a
 * test that asserts "connection refused" fails loudly if something did take it,
 * rather than passing for a reason it did not choose.
 */
export const freePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("the port probe did not return a numeric address"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
