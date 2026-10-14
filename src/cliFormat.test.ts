import { describe, expect, it } from "vitest";

import {
  LABEL_WIDTH,
  bytes,
  clip,
  commandList,
  millis,
  oneLine,
  row,
  rows,
  table,
} from "./cli/format.js";
import { at, bool, isRecord, list, num, obj, str, strings, yesNo } from "./cli/readOutput.js";

/**
 * The human rendering is the second copy of a result, and the JSON on stdout is
 * the authoritative one — so this layer is allowed to drop fields, but not to
 * say something the JSON does not say. Two failures are worth the tests below:
 * a layout that shifts when a cell outgrows its header (which makes a table
 * unreadable exactly when the data is interesting), and a helper that renders a
 * missing value as the text `undefined`, which reads as an observation.
 */

const linesOf = (text: string): readonly string[] => text.split("\n");

/** The column every value in a rendered block starts at, as an index. */
const columnOf = (line: string, needle: string): number => line.indexOf(needle);

describe("row", () => {
  it("pads the label so values line up whatever the label's length", () => {
    for (const label of ["a", "ready", "partial", "twelve chars"]) {
      expect(columnOf(row(label, "yes"), "yes")).toBe(LABEL_WIDTH + 1);
    }
  });

  it("puts exactly one space between the padded label and the value", () => {
    const rendered = row("ready", "yes");
    expect(rendered.startsWith("ready")).toBe(true);
    expect(rendered.length).toBe(LABEL_WIDTH + 1 + "yes".length);
  });
});

describe("rows", () => {
  it("indents continuation values under the first one", () => {
    const values = ["first", "second"];
    const block = rows("unknowns", values);
    expect(block).toHaveLength(2);
    expect(block[0]).toBe(row("unknowns", "first"));
    for (const [index, value] of values.entries()) {
      expect(columnOf(block[index] ?? "", value)).toBe(LABEL_WIDTH + 1);
    }
  });

  it("renders nothing for an empty list, rather than a label with nothing after it", () => {
    // A label with no values would read as "there are none"; an absent block
    // reads as "this was not part of the result".
    expect(rows("unknowns", [])).toEqual([]);
  });
});

describe("bytes", () => {
  it("changes unit exactly at the boundary, so 1023 bytes is not 1.0 KiB", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(1023)).toBe("1023 B");
    expect(bytes(1024)).toBe("1.0 KiB");
    expect(bytes(1536)).toBe("1.5 KiB");
  });

  it("uses MiB only above a mebibyte", () => {
    expect(bytes(1024 * 1024 - 1).endsWith("KiB")).toBe(true);
    expect(bytes(1024 * 1024)).toBe("1.0 MiB");
  });
});

describe("millis", () => {
  it("switches to seconds at exactly one second", () => {
    expect(millis(0)).toBe("0 ms");
    expect(millis(999)).toBe("999 ms");
    expect(millis(1000)).toBe("1.00 s");
    expect(millis(1500)).toBe("1.50 s");
  });
});

describe("oneLine", () => {
  it("collapses every run of whitespace, so a multi-line value stays on one line", () => {
    expect(oneLine("  a\n\tb  ")).toBe("a b");
    expect(oneLine("   \n \t ")).toBe("");
  });

  it("counts the ellipsis inside the limit, so the result never exceeds it", () => {
    // An off-by-one here silently widens every line the renderer prints and
    // breaks the column budget the caller sized.
    const truncated = oneLine("abcdef", 4);
    expect(truncated).toBe("abc…");
    expect(truncated.length).toBe(4);
    expect(oneLine("x".repeat(200)).length).toBe(120);
  });

  it("leaves text that exactly fills the limit alone, with no dangling ellipsis", () => {
    expect(oneLine("abcd", 4)).toBe("abcd");
  });
});

describe("clip", () => {
  it("announces how much it dropped rather than cutting in silence", () => {
    // A silent prefix reads as the whole value. The count is the difference
    // between "this is the body" and "this is the start of the body".
    const text = "abcdefgh";
    expect(clip(text, 3)).toBe("abc\n… (5 more characters)");
    expect(clip(text, 3)).toContain(`${String(text.length - 3)} more characters`);
  });

  it("returns text that fits untouched, with no announcement", () => {
    expect(clip("abc", 5)).toBe("abc");
  });
});

describe("table", () => {
  it("renders the header and the body with two spaces between columns", () => {
    expect(table(["NAME", "SIZE"], [["x", "1 B"]])).toBe("NAME  SIZE\nx     1 B");
  });

  it("widens a column to its widest cell, so a long cell does not shift the rest", () => {
    // The failure this prevents: one long description pushing every later
    // column of its own row out of line with the others.
    const rendered = table(
      ["CMD", "DESC", "STATE"],
      [
        ["build", "a much longer description", "ok"],
        ["verify", "short", "partial"],
      ],
    );
    const [header = "", ...body] = linesOf(rendered);
    const descColumn = columnOf(header, "DESC");
    const stateColumn = columnOf(header, "STATE");
    expect(descColumn).toBeGreaterThan(0);
    expect(stateColumn).toBeGreaterThan(descColumn);
    expect(body).toHaveLength(2);
    expect(body[0]?.slice(descColumn, descColumn + 5)).toBe("a muc");
    expect(body[1]?.slice(descColumn, descColumn + 5)).toBe("short");
    expect(body[0]?.slice(stateColumn)).toBe("ok");
    expect(body[1]?.slice(stateColumn)).toBe("partial");
  });

  it("never pads the last column, so no line carries trailing whitespace", () => {
    for (const line of linesOf(table(["A", "B"], [["x", ""]]))) {
      expect(line.endsWith(" ")).toBe(false);
    }
  });

  it("renders a header-only table when there are no rows", () => {
    expect(table(["A", "B"], [])).toBe("A  B");
  });
});

describe("commandList", () => {
  it("aligns descriptions under each other whatever the name's length", () => {
    const rendered = commandList([
      ["build", "Compile."],
      ["capture start", "Record."],
    ]);
    expect(rendered).toEqual(["  build          Compile.", "  capture start  Record."]);
    expect(columnOf(rendered[0] ?? "", "Compile.")).toBe(columnOf(rendered[1] ?? "", "Record."));
  });

  it("indents by two spaces so it reads as a list rather than as a table row", () => {
    for (const line of commandList([["build", "Compile."]])) {
      expect(line.startsWith("  build")).toBe(true);
    }
  });

  it("trims trailing whitespace when an entry has no description", () => {
    expect(commandList([["a", ""]])).toEqual(["  a"]);
  });

  it("renders nothing for no entries, rather than a line of padding", () => {
    expect(commandList([])).toEqual([]);
  });
});

// Every value a contract parse can hand a renderer: the wrong types, the empty
// ones, and the numeric oddities that are neither.
const AWKWARD_VALUES: readonly unknown[] = [
  undefined,
  null,
  0,
  1,
  "",
  "x",
  false,
  true,
  [],
  {},
  Number.NaN,
  Number.POSITIVE_INFINITY,
];

describe("readOutput readers", () => {
  it("never renders a missing value as the text `undefined`", () => {
    // The bug these helpers exist to prevent: `undefined` printed into a
    // user-facing line reads as a finding rather than as an absence.
    for (const value of AWKWARD_VALUES) {
      expect(str(value)).not.toContain("undefined");
      expect(yesNo(value)).not.toContain("undefined");
    }
  });

  it("always returns its documented shape, whatever it was handed", () => {
    for (const value of AWKWARD_VALUES) {
      expect(typeof str(value)).toBe("string");
      expect(typeof yesNo(value)).toBe("string");
      expect(Array.isArray(list(value))).toBe(true);
      expect(Array.isArray(strings(value))).toBe(true);
      expect(isRecord(obj(value))).toBe(true);
      expect(num(value) === undefined || typeof num(value) === "number").toBe(true);
      expect(bool(value) === undefined || typeof bool(value) === "boolean").toBe(true);
    }
  });
});

describe("str", () => {
  it("falls back for a value of the wrong type rather than stringifying it", () => {
    // `str(7)` rendered as "7" would hide the fact that the contract changed.
    expect(str(undefined)).toBe("");
    expect(str(null, "d")).toBe("d");
    expect(str(7, "d")).toBe("d");
    expect(str([], "d")).toBe("d");
  });

  it("treats an empty string as a value, not as a missing one", () => {
    // The fallback is for a wrong type; an empty string is what the tool said.
    expect(str("", "d")).toBe("");
    expect(str("x")).toBe("x");
  });
});

describe("num", () => {
  it("reads zero as a measurement, not as an absence", () => {
    expect(num(0)).toBe(0);
    expect(num(12.5)).toBe(12.5);
  });

  it("rejects the values that would print as a number nobody measured", () => {
    expect(num(Number.NaN)).toBeUndefined();
    expect(num(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(num(undefined)).toBeUndefined();
    expect(num("5")).toBeUndefined();
  });
});

describe("bool", () => {
  it("reads false as false, which is a finding", () => {
    expect(bool(false)).toBe(false);
    expect(bool(true)).toBe(true);
  });

  it("rejects the near-misses rather than coercing them", () => {
    expect(bool(0)).toBeUndefined();
    expect(bool("false")).toBeUndefined();
    expect(bool(undefined)).toBeUndefined();
  });
});

describe("obj, list, strings and at", () => {
  it("treats an array and a null as not being a record", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord({})).toBe(true);
    expect(obj("x")).toEqual({});
    expect(obj(undefined)).toEqual({});
  });

  it("treats a string as not being a list, so it is never iterated character by character", () => {
    expect(list("abc")).toEqual([]);
    expect(list(["a"])).toEqual(["a"]);
    expect(list(null)).toEqual([]);
  });

  it("keeps only the strings in a mixed list", () => {
    expect(strings(["a", 1, null, "b"])).toEqual(["a", "b"]);
    expect(strings("abc")).toEqual([]);
    expect(strings(undefined)).toEqual([]);
  });

  it("reads a field of a record and nothing at all out of anything else", () => {
    expect(at({ a: 1 }, "a")).toBe(1);
    expect(at({}, "a")).toBeUndefined();
    expect(at(null, "a")).toBeUndefined();
    // An array reached through `at` is not indexed: index access goes through
    // `list`, so a caller cannot silently treat a list as a map.
    expect(at(["a"], "0")).toBeUndefined();
  });
});

describe("yesNo", () => {
  it("has three states, because a missing boolean is not `false`", () => {
    expect(yesNo(true)).toBe("yes");
    expect(yesNo(false)).toBe("no");
    expect(yesNo(undefined)).toBe("unknown");
    expect(yesNo(null)).toBe("unknown");
  });

  it("does not read a string or a number as a boolean", () => {
    expect(yesNo("true")).toBe("unknown");
    expect(yesNo(0)).toBe("unknown");
  });
});
