import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEMPLATE_ARCHIVE_LIMITS,
  TemplateArchiveError,
  extractTemplateArchive,
  type TemplateArchiveErrorCode,
} from "./templateArchive.js";

import { makeTar, makeTarGz, TAR_BLOCK_SIZE } from "../../tests/support/templateArchiveFixture.js";

/**
 * The archive reader is the boundary between an untrusted registry tarball and
 * a package directory. These tests pin the two things that boundary promises:
 * a valid ustar archive round-trips in order, and every structural escape or
 * unsupported entry is refused with the entry it came from.
 */

const text = (value: string): Buffer => Buffer.from(value, "utf8");

interface Observed {
  readonly code: TemplateArchiveErrorCode;
  readonly location: string;
  readonly message: string;
}

const failureOf = (operation: () => unknown): Observed => {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof TemplateArchiveError)) throw error;
    return { code: error.code, location: error.location, message: error.message };
  }
  throw new Error("expected the archive reader to throw");
};

describe("extracting a package archive", () => {
  it("round-trips files in archive order, including a ustar prefix", () => {
    const main = text("int main() { return 0; }\n");
    const readme = text("# Acme\n");
    const archive = makeTarGz([
      { path: "files/src/main.cc", bytes: main, usePrefix: true },
      { path: "README.md", bytes: readme },
      { path: "empty.txt", bytes: Buffer.alloc(0) },
    ]);

    const entries = extractTemplateArchive(archive);

    expect(entries.map((entry) => entry.path)).toEqual([
      "files/src/main.cc",
      "README.md",
      "empty.txt",
    ]);
    expect(entries[0]?.bytes.toString("utf8")).toBe(main.toString("utf8"));
    expect(entries[1]?.bytes.toString("utf8")).toBe(readme.toString("utf8"));
    expect(entries[2]?.bytes).toHaveLength(0);
  });

  it("refuses a traversal segment", () => {
    const failure = failureOf(() =>
      extractTemplateArchive(makeTarGz([{ path: "../evil.txt", bytes: text("x") }])),
    );

    expect(failure.code).toBe("unsafe_path");
    expect(failure.location).toBe("entries[0]");
    expect(failure.message).toContain("'..' segment");
  });

  it("refuses an absolute path", () => {
    const failure = failureOf(() =>
      extractTemplateArchive(makeTarGz([{ path: "/etc/passwd", bytes: text("x") }])),
    );

    expect(failure.code).toBe("unsafe_path");
    expect(failure.message).toContain("is absolute");
  });

  it("refuses a symlink", () => {
    const failure = failureOf(() =>
      extractTemplateArchive(makeTarGz([{ path: "link", type: "2" }])),
    );

    expect(failure.code).toBe("unsupported_entry");
    expect(failure.location).toBe("entries[0]");
    expect(failure.message).toContain("symlink");
  });

  it("refuses a truncated entry and names the entry", () => {
    // A header that declares five bytes, followed by two bytes and no padding.
    const tar = makeTar([{ path: "a.txt", bytes: text("hello") }]);
    const cut = tar.subarray(0, TAR_BLOCK_SIZE + 2);

    const failure = failureOf(() => extractTemplateArchive(gzipSync(cut)));

    expect(failure.code).toBe("truncated");
    expect(failure.location).toBe("entries[0]");
    expect(failure.message).toContain("declares 5 bytes");
  });

  it("refuses a file larger than maxFileBytes", () => {
    const failure = failureOf(() =>
      extractTemplateArchive(makeTarGz([{ path: "big", bytes: Buffer.alloc(5) }]), {
        ...DEFAULT_TEMPLATE_ARCHIVE_LIMITS,
        maxFileBytes: 4,
      }),
    );

    expect(failure.code).toBe("file_too_large");
    expect(failure.location).toBe("entries[0]");
    expect(failure.message).toContain("more than the 4 allowed");
  });
});

describe("the archive reader's other refusals", () => {
  it("refuses a header whose checksum does not match", () => {
    const failure = failureOf(() =>
      extractTemplateArchive(makeTarGz([{ path: "a.txt", bytes: text("x"), checksum: 0 }])),
    );

    expect(failure.code).toBe("corrupt");
    expect(failure.message).toContain("checksum");
  });

  it("refuses a duplicate entry", () => {
    const failure = failureOf(() =>
      extractTemplateArchive(
        makeTarGz([
          { path: "a.txt", bytes: text("one") },
          { path: "./a.txt", bytes: text("two") },
        ]),
      ),
    );

    // `./a.txt` is refused before it can be compared as a duplicate.
    expect(failure.code).toBe("unsafe_path");

    const exact = failureOf(() =>
      extractTemplateArchive(
        makeTarGz([
          { path: "a.txt", bytes: text("one") },
          { path: "a.txt", bytes: text("two") },
        ]),
      ),
    );
    expect(exact.code).toBe("duplicate_entry");
    expect(exact.location).toBe("entries[1]");
  });

  it("refuses pax and GNU long-name records instead of silently skipping them", () => {
    const pax = failureOf(() =>
      extractTemplateArchive(makeTarGz([{ path: "PaxHeaders/a", type: "x" }])),
    );
    expect(pax.code).toBe("unsupported_feature");
    expect(pax.message).toContain("pax extended header");

    const longName = failureOf(() =>
      extractTemplateArchive(makeTarGz([{ path: "././@LongLink", type: "L" }])),
    );
    expect(longName.code).toBe("unsupported_feature");
    expect(longName.message).toContain("GNU long name");
  });

  it("refuses non-portable archive paths before anything is written", () => {
    for (const path of [
      "dir\\file",
      "dir//file",
      "C:/file",
      "dir/./file",
      "aux",
      "bad\nname",
      "dir/trailing.",
      "dir/colon:name",
    ]) {
      const failure = failureOf(() => extractTemplateArchive(makeTarGz([{ path }])));
      expect(failure.code, path).toBe("unsafe_path");
    }
  });

  it("refuses more files or more total bytes than the limits allow", () => {
    const tooMany = failureOf(() =>
      extractTemplateArchive(
        makeTarGz([
          { path: "a", bytes: text("a") },
          { path: "b", bytes: text("b") },
        ]),
        { ...DEFAULT_TEMPLATE_ARCHIVE_LIMITS, maxFiles: 1 },
      ),
    );
    expect(tooMany.code).toBe("too_many_files");

    const tooLarge = failureOf(() =>
      extractTemplateArchive(
        makeTarGz([
          { path: "a", bytes: text("abc") },
          { path: "b", bytes: text("de") },
        ]),
        { ...DEFAULT_TEMPLATE_ARCHIVE_LIMITS, maxBytes: 4 },
      ),
    );
    expect(tooLarge.code).toBe("total_too_large");
  });

  it("refuses input that is not gzip", () => {
    const failure = failureOf(() => extractTemplateArchive(text("not a gzip stream")));
    expect(failure.code).toBe("corrupt");
    expect(failure.location).toBe("archive");
  });

  it("refuses an archive that ends without the end-of-archive marker", () => {
    const tar = makeTar([{ path: "a.txt", bytes: text("x") }]);
    // Drop both zero blocks, leaving a complete entry and no terminator.
    const withoutMarker = tar.subarray(0, tar.length - TAR_BLOCK_SIZE * 2);
    const failure = failureOf(() => extractTemplateArchive(gzipSync(withoutMarker)));
    expect(failure.code).toBe("truncated");
    expect(failure.message).toContain("end-of-archive");
  });

  it("bounds the decompressed output so a gzip bomb is refused", () => {
    const huge = Buffer.alloc(64 * 1024);
    const failure = failureOf(() =>
      extractTemplateArchive(makeTarGz([{ path: "a.bin", bytes: huge }]), {
        ...DEFAULT_TEMPLATE_ARCHIVE_LIMITS,
        maxFileBytes: 1024,
        maxBytes: 1024,
        maxFiles: 1,
      }),
    );
    // The declared-size check runs before memory grows past the cap; either the
    // entry check or gunzip's output cap is an acceptable refusal, but it must
    // not allocate the whole stream.
    expect(["file_too_large", "too_large"]).toContain(failure.code);
  });
});
