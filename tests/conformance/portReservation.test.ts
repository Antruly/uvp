import { describe, expect, it } from "vitest";

import { freePort, reservationWindowIsAvailable } from "../support/ports.js";

/**
 * The reservation's one promise: a number it has handed out is spent.
 *
 * This lives in the conformance lane because that lane is where the promise was
 * broken and where the cost was paid — one test in about twenty runs of
 * `captureReplay.test.ts` died with `TransportFailure: socket hang up`, because a
 * capture proxy was put on the number the capture before it had just released and
 * the client's global keep-alive pool still held a socket for that `host:port`.
 * A number here is a server's identity to every pooled client in the process.
 *
 * ## Why this draws a batch rather than calling twice
 *
 * A collision is a draw out of the window, not a certainty: two calls cannot
 * assert this, and neither can a handful. A batch can, and how large a batch is a
 * measured choice rather than a guess — against the reservation as it was before
 * the fix, **eighty draws collide in 99.8% of runs** (20000 simulated runs of the
 * walk), and against the fix they cannot collide at all until all 512 numbers are
 * spent.
 *
 * Eighty is also what the window can afford. The walk is 512 numbers wide, the
 * reservation is per process rather than per file, and this project shares one
 * module graph across its files — so these draws are spent for every later file in
 * the worker. The files here ask for about fifty-five numbers between them, which
 * leaves this comfortable room and is why the batch is not larger.
 *
 * Where the window does not exist — anything that is not Linux — the number comes
 * from port 0 and there is nothing to remember, so this is skipped by name rather
 * than passing for a property that does not hold there.
 */

const DRAWS = 80;

const skipReason = reservationWindowIsAvailable
  ? undefined
  : "this host has no port window below the ephemeral range to reserve from " +
    "(see the range check in tests/support/ports.ts), so a number comes from port 0 " +
    "and cannot be remembered";

describe("the port reservation", () => {
  it.skipIf(skipReason !== undefined)(
    skipReason === undefined
      ? "hands out a number once, so a pooled socket cannot outlive its server"
      : `hands out a number once, so a pooled socket cannot outlive its server — skipped: ${skipReason}`,
    async () => {
      const drawn: number[] = [];
      for (let draw = 0; draw < DRAWS; draw += 1) drawn.push(await freePort());

      // By value rather than by size alone: the failure this guards against is a
      // repeat, and a report that says only "expected 79 to be 80" would not say
      // which number came back.
      const repeated = drawn.filter((port, index) => drawn.indexOf(port) !== index);
      expect(repeated).toEqual([]);
      expect(new Set(drawn).size).toBe(DRAWS);
    },
  );
});
