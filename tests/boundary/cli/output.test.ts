import { describe, expect, it } from "vitest";

import { isBrokenPipeError } from "../../../src/cli/output.js";

describe("stdout pipe closure", () => {
  it("recognises an EPIPE as a closed consumer, not a command failure", () => {
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(isBrokenPipeError(error)).toBe(true);
  });

  it("recognises a destroyed stream as closed", () => {
    expect(isBrokenPipeError({ code: "ERR_STREAM_DESTROYED" })).toBe(true);
  });

  it("does not hide an unrelated stream error", () => {
    expect(isBrokenPipeError(Object.assign(new Error("nope"), { code: "EIO" }))).toBe(false);
    expect(isBrokenPipeError(new Error("no code"))).toBe(false);
    expect(isBrokenPipeError(undefined)).toBe(false);
  });
});
