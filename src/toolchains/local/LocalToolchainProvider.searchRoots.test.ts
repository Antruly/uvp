import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { removeTree } from "../../../tests/support/temporaryTree.js";
import { isWindows } from "../host.js";
import { LocalToolchainProvider } from "./LocalToolchainProvider.js";

/**
 * How the search reads `CMAKE_PREFIX_PATH`.
 *
 * The defect [#80](https://github.com/Antruly/uvp/issues/80) records: the value
 * was pushed into the search roots as one directory. A caller whose list has two
 * entries — the shape the installation guide produces with
 * `export CMAKE_PREFIX_PATH="$HOME/.local:$CMAKE_PREFIX_PATH"` — was told no
 * libuvcpp was installed even when one entry was a complete install.
 *
 * The Windows case is the reason the separator matters rather than being a
 * detail: every absolute Windows path starts with `C:`, so a reader that split on
 * `:` there would turn one prefix into two strings that are not directories. The
 * Windows-only test below names that risk and skips everywhere else, with the
 * reason in its own title.
 */

/** A prefix shaped like a libuvcpp install, holding just enough to be discovered. */
const fakeInstall = (root: string, name: string): string => {
  const prefix = join(root, name);
  mkdirSync(join(prefix, "include", "uvcpp"), { recursive: true });
  writeFileSync(
    join(prefix, "include", "uvcpp", "uvcpp_config.h"),
    "#define UVCPP_HTTP_ENABLE 1\n",
  );
  mkdirSync(join(prefix, "lib", "cmake", "uvcpp"), { recursive: true });
  writeFileSync(
    join(prefix, "lib", "cmake", "uvcpp", "uvcppConfig.cmake"),
    'set(PACKAGE_VERSION "1.7.0")\n',
  );
  mkdirSync(join(prefix, "lib", "pkgconfig"), { recursive: true });
  writeFileSync(join(prefix, "lib", "pkgconfig", "uvcpp.pc"), "Name: uvcpp\nVersion: 1.7.0\n");
  return prefix;
};

const provider = new LocalToolchainProvider();
const signal = new AbortController().signal;

let root: string;
let prefix: string;
let absent: string;
let saved: Record<string, string | undefined>;

/** The discovered install, from the fixture this file made. */
const found = async () => await provider.findLibuvcpp(undefined, signal);

beforeAll(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "uvp-prefix-list-"));
  // A space in the name, because the prefix is carried in the recorded command
  // line as well as read here, and a reader that only works without one is the
  // failure this project already fixed once (#20).
  prefix = fakeInstall(root, "a prefix");
  absent = join(root, "not-an-install");
});

beforeEach(() => {
  saved = {
    UVCPP_ROOT: process.env["UVCPP_ROOT"],
    LIBUVCPP_ROOT: process.env["LIBUVCPP_ROOT"],
    CMAKE_PREFIX_PATH: process.env["CMAKE_PREFIX_PATH"],
  };
  // The single-root variables are cleared so the only way the fixture can be
  // found is the variable each test is about. A host that happens to have one of
  // them set would otherwise make every test below pass for the wrong reason.
  delete process.env["UVCPP_ROOT"];
  delete process.env["LIBUVCPP_ROOT"];
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterAll(async () => {
  await removeTree(root);
});

describe("the prefixes a libuvcpp search reads", () => {
  it("is the control: one entry is still found", async () => {
    process.env["CMAKE_PREFIX_PATH"] = prefix;
    const result = await found();
    expect(result.found).toBe(true);
    expect(result.installPrefix).toBe(prefix);
    expect(result.modules).toEqual(["UVCPP_HTTP_ENABLE"]);
  });

  it("finds a prefix that is one entry of a platform-separated list", async () => {
    // The reproduction from #80: the install is the second entry, and the first
    // names a directory that is not one.
    process.env["CMAKE_PREFIX_PATH"] = [absent, prefix].join(delimiter);
    const result = await found();
    expect(result.found).toBe(true);
    expect(result.installPrefix).toBe(prefix);
  });

  it("accepts a semicolon list here as well as the platform separator", async () => {
    // CMake uses `;` on Windows and `:` on UNIX. A caller may write either, so
    // both are accepted here; the platform list is the one the guide uses.
    process.env["CMAKE_PREFIX_PATH"] = [absent, prefix].join(";");
    expect((await found()).installPrefix).toBe(prefix);
  });

  it("ignores empty entries and a trailing separator", async () => {
    // A shell that appends to an unset variable produces the empty entry; an
    // empty string is not a directory named "", and searching it would be an
    // error at the first `stat`.
    process.env["CMAKE_PREFIX_PATH"] = ["", prefix, ""].join(delimiter);
    expect((await found()).installPrefix).toBe(prefix);
  });
});

describe.skipIf(!isWindows)(
  isWindows
    ? "a Windows drive letter in CMAKE_PREFIX_PATH"
    : "a Windows drive letter in CMAKE_PREFIX_PATH — skipped: not a Windows host",
  () => {
    it("does not split a prefix at its drive letter", async () => {
      // The fixture's absolute path starts with `C:` on this host. A reader that
      // split on `:` here would search `C` and `\…`, neither of which is the
      // install; the value is a single entry as far as CMake is concerned.
      process.env["CMAKE_PREFIX_PATH"] = prefix;
      const result = await found();
      expect(result.found).toBe(true);
      expect(result.installPrefix).toBe(prefix);
    });
  },
);
