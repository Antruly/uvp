import { describe, expect, it } from "vitest";

import { captureListenFailure } from "./CaptureService.js";

/**
 * The bind half of the split in
 * [#49](https://github.com/Antruly/uvp/issues/49).
 *
 * The decision is a pure mapping, so it is tested without binding a socket: a
 * port another process holds has an obvious caller remedy and stays
 * `service_unavailable` (retryable, because the port may free up); every other
 * bind failure is a permission or configuration fact a retry does not change and
 * is `capture_listen_failed`, category `execution_failure`, not retryable. The
 * missing-session half is `capture_not_found` and is pinned in
 * `domain/errors.test.ts` and `tests/conformance/captureReplay.test.ts`.
 */

/** An `ErrnoException` shaped the way Node raises one, with a chosen `code`. */
const bindError = (code: string, message: string): NodeJS.ErrnoException => {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
};

describe("the failure a capture proxy reports when it cannot listen", () => {
  it("names a port already in use as service_unavailable, with the port", () => {
    const failure = captureListenFailure(bindError("EADDRINUSE", "address in use"), 8080);
    expect(failure.detail.code).toBe("service_unavailable");
    expect(failure.detail.category).toBe("unavailable");
    expect(failure.detail.retryable).toBe(true);
    expect(failure.detail.message).toContain("8080");
    expect(failure.detail.remediation.action).toContain("free listen_port");
  });

  it("names any other bind failure as capture_listen_failed, and does not call it retryable", () => {
    // The half that used to be reported as `capture_unavailable`, whose remedy is
    // "start a session" — advice that cannot fix a socket the process may not
    // open. `execution_failure` is where `launch_failed` sits: the thing could not
    // start, and the remedy is the caller's to perform.
    const failure = captureListenFailure(bindError("EACCES", "permission denied"), 80);
    expect(failure.detail.code).toBe("capture_listen_failed");
    expect(failure.detail.category).toBe("execution_failure");
    expect(failure.detail.retryable).toBe(false);
    expect(failure.detail.message).toContain("permission denied");
    expect(failure.detail.remediation.action).toContain("listening socket");
  });
});
