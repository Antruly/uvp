import { startSupervised } from "../../../../dist/toolchains/local/processRunner.js";

/**
 * A detached service and the parent that let go of it.
 *
 * This is the shape of `uvp run` with its default detach: start a service, hand
 * ownership over with `release()`, report, and exit — while the service keeps
 * running. It is a fixture because the property under test belongs to a process
 * that has *exited*: whether the released child survived its parent, and what
 * became of the output it wrote afterwards, can only be observed from outside, by
 * something that outlives both. The lane checks both afterwards.
 *
 * It runs against `dist/`, not `src/`, for the same reason: this is the compiled
 * module a published uvp would load.
 *
 * Two lines on stdout, both JSON. The pid as soon as the service is up — so a
 * watcher can clean up even if everything after this hangs — and then what the
 * output tail looked like before and after the release.
 *
 * Usage: node detachParent.mjs '<javascript for the service>' '<line to wait for>'
 */

const serviceCode = process.argv[2];
const marker = process.argv[3] ?? "";
if (serviceCode === undefined) {
  process.stderr.write("detachParent: expected the service's code as the first argument\n");
  process.exit(2);
}

const child = startSupervised({ command: process.execPath, args: ["-e", serviceCode] });
await child.whenStarted();
process.stdout.write(`${JSON.stringify({ pid: child.pid })}\n`);

/** Wait until the tail contains `marker`, or is non-empty when there is none. */
const waitForTail = async (timeoutMs) => {
  const ready = () =>
    marker === "" ? child.stdoutTail() !== "" : child.stdoutTail().includes(marker);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !ready()) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

await waitForTail(5_000);
const before = child.stdoutTail();
child.release();
// Longer than the service's own delay before its next line, so a tail that was
// still being observed would show it.
await new Promise((resolve) => setTimeout(resolve, 1_000));
process.stdout.write(`${JSON.stringify({ before, after: child.stdoutTail() })}\n`);
