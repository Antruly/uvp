import { describe, expect, it } from "vitest";

import { captureReplayCommand, websocketCommand } from "./cli/commands/web.js";
import { isToolCommand } from "./cli/commandSpec.js";
import { EXIT_NO, EXIT_WRONG } from "./cli/exitCodes.js";
import type { ParsedArgv } from "./cli/args.js";
import type { ToolCommand } from "./cli/commandSpec.js";

/**
 * The WebSocket command's post-call check.
 *
 * `uvp ws --expect-frame` ends in a check the CLI performs on the result, and the
 * only thing worth testing about it is where the answer comes from. The probe
 * already decides which expectation a frame satisfied, and it is the only party
 * that knows the rule — that a frame uvp *sent* is not evidence the peer spoke,
 * and that on an echo server the sent and expected strings are byte-identical. A
 * second implementation here would pass an expectation against a server that
 * never replied, which is the failure this check exists to catch.
 *
 * The frames in these fixtures are shaped so that a verdict and a re-match
 * disagree: the expected text is present in the log, and the probe's entry says
 * it was not answered.
 */

const ARGV: ParsedArgv = { positionals: [], values: {}, occurrences: [], help: false };

/**
 * The capture replay verdict.
 *
 * `verified` is the only outcome the contract calls a pass. `partial` is
 * produced both by an omission the tool makes on purpose (`skipped`: a writing
 * method is never replayed) and by an exchange whose call did not complete
 * (`not_comparable`). The second is a question that was never put, and the CLI's
 * exit table has a code for that; reporting it as success is the collapse this
 * command's verdict exists to prevent.
 */
describe("the capture replay verdict", () => {
  // `CommandSpec` is the union of tool-driven and local commands, and only the
  // first carries a verdict. This command drives `uvp_capture_replay`, so the
  // guard is a fact the compiler can use rather than a cast. The narrowed value
  // is bound once: a type predicate on the imported const does not survive into
  // a nested arrow function.
  const replay = isToolCommand(captureReplayCommand) ? captureReplayCommand : undefined;
  if (replay === undefined) {
    throw new Error("uvp capture replay must drive a tool contract");
  }
  const verdict = (output: Record<string, unknown>): number | undefined =>
    replay.verdict?.(output, ARGV);

  it("does not report success when a replayed exchange could not be compared", () => {
    expect(
      verdict({ outcome: "partial", matched: 1, differed: 0, skipped: 0, not_comparable: 1 }),
    ).toBe(EXIT_WRONG);
  });

  it("keeps a documented omission at success", () => {
    // A capture with a POST is always partial; exiting 2 for that would make
    // replaying any ordinary capture look like a wrong environment.
    expect(
      verdict({ outcome: "partial", matched: 1, differed: 0, skipped: 1, not_comparable: 0 }),
    ).toBeUndefined();
  });

  it("lets a real difference outrank a comparison that did not run", () => {
    expect(
      verdict({ outcome: "partial", matched: 0, differed: 1, skipped: 0, not_comparable: 1 }),
    ).toBe(EXIT_NO);
  });

  it("still refuses to call a run that compared nothing a pass", () => {
    expect(
      verdict({ outcome: "unknown", matched: 0, differed: 0, skipped: 0, not_comparable: 0 }),
    ).toBe(EXIT_WRONG);
  });
});

/** The command's post-call check, reached the way `runToolCommand` reaches it. */
const verdictOf = (spec: ToolCommand, output: Record<string, unknown>): string | undefined =>
  spec.inspect?.(output, ARGV);

/** A frame holding exactly the text an expectation asks about. */
const frame = (direction: "sent" | "received", text: string): Record<string, unknown> => ({
  direction,
  opcode: "text",
  bytes: Buffer.byteLength(text),
  text,
  at_ms: 3,
  truncated: false,
});

describe("the websocket command's expectation check", () => {
  it("reports the expectations the probe could not match, and only those", () => {
    const missing = verdictOf(websocketCommand, {
      expectations: [
        { text: "pong", matched: false },
        { text: "welcome", matched: true, matched_frame_index: 0 },
      ],
      frames: [frame("sent", "pong")],
    });
    expect(missing).toContain('"pong"');
    expect(missing).not.toContain("welcome");
  });

  it("keeps the probe's answer instead of matching the frame log again", () => {
    // Both halves of the trap, and the log contradicts the verdict in each.
    //
    // Received: `pong` is in the log, so a check that matched it here would call
    // the expectation met — and then `uvp ws` would exit 0 while saying nothing,
    // because the message it prints is the match it computed. Whether a frame
    // answers an expectation is the probe's answer, and this asserts that the
    // check reads it rather than reaching the same conclusion by another route.
    const answered = verdictOf(websocketCommand, {
      expectations: [{ text: "pong", matched: false }],
      frames: [frame("received", "pong")],
    });
    expect(answered, "the check decided for itself that a frame answered").toContain('"pong"');

    // Sent: `pong` is in the log because that is what the caller asked uvp to
    // send. A check that matched the whole log would call this met, which is the
    // echo-server confusion — the sent and expected strings are identical.
    const echoed = verdictOf(websocketCommand, {
      expectations: [{ text: "pong", matched: false }],
      frames: [frame("sent", "pong")],
    });
    expect(echoed, "a sent frame was accepted as the far end answering").toContain('"pong"');
  });

  it("passes when every expectation was answered, and when none was asked", () => {
    expect(
      verdictOf(websocketCommand, {
        expectations: [{ text: "pong", matched: true, matched_frame_index: 1 }],
        frames: [frame("sent", "ping")],
      }),
    ).toBeUndefined();
    // No expectations is not a failed expectation: a probe asked nothing has
    // nothing to report, and the handshake is the whole answer.
    expect(verdictOf(websocketCommand, { expectations: [], frames: [] })).toBeUndefined();
  });
});
