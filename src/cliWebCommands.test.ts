import { describe, expect, it } from "vitest";

import { websocketCommand } from "./cli/commands/web.js";
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
