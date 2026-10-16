// Written for the tests, not by uvp.
//
// Stands in for a built service that runs until something stops it: it writes its
// own pid where it was told to, then waits. The pid is written by the *program*,
// so it is the process uvp started rather than a shell that launched it — which
// is why the fake in `tests/support/fakeExecutable.ts` `exec`s this Node instead
// of running it as a child — and it is written before the wait, so a caller that
// withdraws early can never outrun it.
//
// The second argument is where it records that it was asked to stop, which is
// the claim `tests/composition/runCancellation.test.ts` reads: the service's own
// account of the stop, rather than uvp's inference from a process's absence.
// Only a host with signals can produce it. A stop on Windows is
// `TerminateProcess` — `processRunner.ts` calls `child.kill("SIGTERM")`, which
// libuv maps to the same call as `SIGKILL` — so the process is gone before any
// handler of its own runs. That is why the test that reads this file says in its
// name that Windows cannot check it rather than asserting something weaker.
import { writeFileSync } from "node:fs";

const [pidFile, stopFile] = process.argv.slice(2);
if (pidFile === undefined || stopFile === undefined) {
  throw new Error("stopsWhenAsked.mjs takes a pid file and a stop file");
}

writeFileSync(pidFile, `${String(process.pid)}\n`);
process.on("SIGTERM", () => {
  writeFileSync(stopFile, "stopped\n");
  process.exit(0);
});

// A timer rather than a sleep loop, so the process stays alive with nothing to
// do and cannot exit on its own before the caller withdraws.
setInterval(() => undefined, 1_000);
