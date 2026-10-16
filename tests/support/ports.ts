import { readFileSync } from "node:fs";
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
 * ## Why the number does not come from port 0
 *
 * Asking the kernel for port 0 returns an *ephemeral* port, and the ephemeral
 * range is the same pool a TCP client's source port is drawn from. So the port is
 * free when the probe closes it and can be taken by any outbound connection this
 * suite opens a moment later — and the service that was told to listen there gets
 * `EADDRINUSE` for a number nobody chose on purpose. That is not hypothetical: it
 * is how CI's first run failed, on 33097, inside the default Linux range.
 *
 * The value used instead comes from just below that range, which the kernel never
 * hands out as a source port. The bind probe still stands: a candidate that is
 * genuinely occupied — by another service on this machine, or by another test
 * worker that got there first — is rejected and the next one is tried, and the
 * walk starts at a random offset so two workers do not walk in step.
 *
 * Where the range cannot be read (anything that is not Linux) the behaviour is
 * the old one, port 0 included. A host whose range is unknown is a host where a
 * fixed guess would be worse than the race, and this file says so rather than
 * pretending the reservation is stronger than it is.
 *
 * ## Why a number is handed out once
 *
 * A number is a server's identity to every client in this process. uvp's own
 * client calls `http.request` with no `agent` and so gets `http.globalAgent`,
 * keep-alive since Node 19 and pooled by `host:port` for the life of the process.
 * A number handed out twice therefore hands a client's pooled socket to a server
 * it was never opened to, and the first request written into it dies with
 * `ECONNRESET: socket hang up`, while the one after it opens a fresh connection
 * and succeeds.
 *
 * The bind probe cannot see that on its own: a listener that has stopped makes its
 * number genuinely free again, so the probe is right that nothing holds it and
 * wrong that nothing here has spent it. The window is 512 numbers wide and a lane
 * makes dozens of calls, so this was not rare — a capture proxy put on the number
 * the capture before it had just released killed one test in about twenty runs of
 * `tests/conformance/captureReplay.test.ts`. Every number issued is remembered for
 * the life of the process, and the walk skips a spent number the way it skips an
 * occupied one.
 *
 * A caller that needs the port to remain free should say so in the failure: a
 * test that asserts "connection refused" fails loudly if something did take it,
 * rather than passing for a reason it did not choose.
 */

/** How far below the ephemeral range this file is willing to look. */
const WINDOW = 512;

/**
 * The lowest port the kernel will hand out for an outbound connection, or
 * `undefined` where that is not knowable from here.
 *
 * `/proc/sys/net/ipv4/ip_local_port_range` is the kernel's own answer on Linux.
 * It is read once per process: it is not a value that changes under a test run.
 */
const ephemeralFloor = ((): number | undefined => {
  try {
    const [low] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
      .trim()
      .split(/\s+/u);
    const floor = Number(low);
    // A floor that is not a usable port leaves nothing to search below, and a
    // floor at or under the privileged range would put the window in it.
    return Number.isInteger(floor) && floor > WINDOW + 1024 ? floor : undefined;
  } catch {
    return undefined;
  }
})();

/** One candidate, bound and released. `undefined` when something else has it. */
const probe = async (port: number): Promise<boolean> =>
  await new Promise((resolve) => {
    const socket = createServer();
    socket.once("error", () => {
      resolve(false);
    });
    socket.listen(port, "127.0.0.1", () => {
      socket.close(() => {
        resolve(true);
      });
    });
  });

/** Port 0: the kernel picks, out of the range that also serves source ports. */
const anyFreePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (address === null || typeof address === "string") {
        socket.close();
        reject(new Error("the port probe did not return a numeric address"));
        return;
      }
      const { port } = address;
      socket.close(() => {
        resolve(port);
      });
    });
  });

/**
 * Every number this process has handed out, for the life of the process.
 *
 * Never cleared, because the thing that makes a second hand-out dangerous — a
 * client's pooled socket — outlives the listener it was opened to. The walk below
 * consults it, and the port-0 path adds to it, so that a number the kernel picked
 * out of the ephemeral range is not handed out again by the walk either.
 */
const issued: Set<number> = new Set();

/** Hand a number out, and remember it for as long as this process runs. */
const remember = (port: number): number => {
  issued.add(port);
  return port;
};

/** Whether this host has a window to reserve from, which the walk needs. */
export const reservationWindowIsAvailable = ephemeralFloor !== undefined;

export const freePort = async (): Promise<number> => {
  if (ephemeralFloor === undefined) return remember(await anyFreePort());
  const start = ephemeralFloor - WINDOW;
  // A random offset per call, so two workers reserving at the same moment are
  // unlikely to be looking at the same candidates in the same order.
  const offset = Math.floor(Math.random() * WINDOW);
  for (let step = 0; step < WINDOW; step += 1) {
    const port = start + ((offset + step) % WINDOW);
    if (issued.has(port)) continue;
    if (await probe(port)) return remember(port);
  }
  // Every candidate in the window is either taken by something else on this
  // machine or already spent by this process. Falling back is better than
  // failing: the caller's own bind says whether the number it gets is really
  // free, and a port in the ephemeral range is what it would have had before this
  // file looked at the range at all. This is also the one path that can hand a
  // number out twice, because port 0 cannot be steered away from a spent one —
  // which needs the window's 512 numbers to be spent first, and is why the walk
  // is the guarantee and this is the fallback.
  return remember(await anyFreePort());
};
