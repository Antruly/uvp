import { rm } from "node:fs/promises";

/**
 * Removing a temporary tree that a process may only just have run out of.
 *
 * On Windows a test cannot reliably delete an image whose process has exited
 * microseconds earlier: the file is refused with a sharing violation while the
 * process's section is still being torn down, and again if anything is scanning
 * the file that was just written. The lane printed exactly that, at suite
 * teardown of a file whose every test had passed (run 38904633121):
 *
 *     Error: EBUSY: resource busy or locked, unlink
 *       'C:\Users\RUNNER~1\AppData\Local\Temp\uvp-bundle-diff-qoFS35\svc\build\svc.exe'
 *       tests/conformance/bundleDiff.test.ts
 *
 * It is a window rather than a leak, and the run says so rather than this file
 * asserting it: 38 of the 40 files tore down the same shape of tree in that same
 * run, and a service that was still alive would fail identically every time and
 * in every file that starts one. Unix has no such window at all — unlinking a
 * running program is legal there and the inode outlives the process — which is
 * why the source lanes ran for as long as they did without meeting this.
 *
 * The retry is Node's own, not a loop written here: `fs.rm` retries `EBUSY`,
 * `EMFILE`, `ENFILE`, `ENOTEMPTY` and `EPERM` with a linear backoff
 * (`internal/fs/rimraf` — `delay = retries * retryDelay`), and `maxRetries` is
 * how many of those it gets. The bound is the point: when they run out the error
 * is rethrown, so a tree that genuinely cannot be removed — one whose process is
 * still running, or a permission the test got wrong — fails the suite instead of
 * disappearing into `force: true`, which means "no error if it is already gone",
 * not "no error".
 *
 * This matters here because of what the fixtures put in a workspace: on Windows
 * `installFakeExecutable` and `installFakeTool` (see `fakeExecutable.ts`) copy
 * the Node binary into it, so every test that starts a fake binary leaves a
 * 126 MB image for the host to release before the tree can go.
 */
export const removeTree = async (path: string): Promise<void> => {
  await rm(path, {
    recursive: true,
    force: true,
    // 100 + 200 + … + 600 ms of patience, then the real error.
    maxRetries: 6,
    retryDelay: 100,
  });
};
