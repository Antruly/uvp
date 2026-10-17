import { describe, expect, it } from "vitest";

import { tailText } from "./text.js";

/**
 * The second cut on a captured tail.
 *
 * `processRunner` bounds the tail by bytes and decodes it once, so the text it
 * returns is valid. `WorkspaceService` then keeps the last 4,096 code units for
 * the tool result, and that cut can land between the halves of a surrogate pair.
 * These tests pin the boundary rule rather than a particular stream.
 */
describe("tailText", () => {
  it("returns text shorter than the cap unchanged", () => {
    expect(tailText("abc", 5)).toBe("abc");
    expect(tailText("", 5)).toBe("");
  });

  it("returns an empty string for a non-positive cap", () => {
    expect(tailText("abc", 0)).toBe("");
    expect(tailText("abc", -1)).toBe("");
  });

  it("keeps the last code units, then the whole pair when the cut is inside it", () => {
    // "ab😀" is a, b, high surrogate, low surrogate.
    expect(tailText("ab😀", 1)).toBe("");
    expect(tailText("ab😀", 2)).toBe("😀");
    expect(tailText("ab😀", 3)).toBe("b😀");
  });

  it("never starts on a lone low surrogate, for any cap", () => {
    const text = "a😀中b";
    for (let max = 0; max <= text.length; max += 1) {
      const tail = tailText(text, max);
      // The result is a suffix, never a re-decoded or reordered string.
      expect(text.endsWith(tail)).toBe(true);
      const first = tail.charCodeAt(0);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    }
  });
});
