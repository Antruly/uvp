import { describe, expect, it } from "vitest";

import {
  TOOLCHAIN_CATALOG,
  defaultRelease,
  findRelease,
  hostVariant,
  parseToolchainReference,
  releaseUrl,
} from "./toolchainCatalog.js";

describe("the managed toolchain catalog", () => {
  it("defaults libuvcpp to the host archive and Windows to MinGW", () => {
    expect(hostVariant("libuvcpp", "linux", "x64")).toBe("linux-x64");
    expect(hostVariant("libuvcpp", "linux", "arm64")).toBe("linux-arm64");
    expect(hostVariant("libuvcpp", "win32", "x64")).toBe("mingw-x64");
    expect(hostVariant("libuvcpp", "win32", "arm64")).toBe("mingw-arm64");
    expect(hostVariant("libuvcpp", "darwin", "arm64")).toBeUndefined();
    expect(hostVariant("cmake", "win32", "x64")).toBe("windows-x64");
    expect(hostVariant("cmake", "darwin", "arm64")).toBe("macos-universal");
  });

  it("pins every catalog entry to a full SHA-256 and a unique id", () => {
    const ids = new Set<string>();
    for (const release of TOOLCHAIN_CATALOG) {
      expect(release.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(release.id).toBe(`${release.tool}@${release.version}:${release.variant}`);
      expect(ids.has(release.id)).toBe(false);
      ids.add(release.id);
    }
  });

  it("resolves the newest supported release for the host", () => {
    expect(defaultRelease("libuvcpp", "linux", "x64")?.version).toBe("1.11.0");
    expect(defaultRelease("cmake", "linux", "x64")?.version).toBe("3.31.6");
    expect(findRelease("libuvcpp", { version: "1.9.1", variant: "msvc-x64" })?.asset).toBe(
      "libuvcpp-1.9.1-msvc-x64.zip",
    );
  });

  it("builds a default URL and lets a mirror replace its base", () => {
    const release = findRelease("libuvcpp", { version: "1.11.0", variant: "linux-x64" });
    expect(release).toBeDefined();
    if (release === undefined) return;

    expect(releaseUrl(release)).toBe(
      "https://github.com/Antruly/libuvcpp/releases/download/v1.11.0/" +
        "libuvcpp-1.11.0-linux-x64.zip",
    );
    expect(releaseUrl(release, "https://mirror.example/uvcpp/")).toBe(
      "https://mirror.example/uvcpp/libuvcpp-1.11.0-linux-x64.zip",
    );
    expect(releaseUrl(release, "https://mirror.example/{version}/{variant}/{asset}")).toBe(
      "https://mirror.example/1.11.0/linux-x64/libuvcpp-1.11.0-linux-x64.zip",
    );

    const cmake = findRelease("cmake", { version: "3.31.6", variant: "linux-x64" });
    expect(cmake).toBeDefined();
    if (cmake === undefined) return;
    expect(releaseUrl(cmake)).toBe(
      "https://github.com/Kitware/CMake/releases/download/v3.31.6/" +
        "cmake-3.31.6-linux-x86_64.tar.gz",
    );
  });

  it("parses the reference a caller types", () => {
    expect(parseToolchainReference("libuvcpp@1.11.0:linux-x64")).toEqual({
      tool: "libuvcpp",
      version: "1.11.0",
      variant: "linux-x64",
    });
    expect(parseToolchainReference("cmake")).toEqual({ tool: "cmake" });
    expect(() => parseToolchainReference("node@22")).toThrow(/unknown toolchain/u);
  });
});
