import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findRelease } from "../domain/toolchainCatalog.js";

import {
  CONFIG_SCHEMA,
  ManagedToolchainError,
  installManaged,
  installPath,
  installToolchain,
  readToolchainConfig,
  resolvePowerShellPath,
  selectedCmakePathSync,
  selectedLibuvcppPrefixSync,
  writeToolchainConfig,
} from "./managedToolchains.js";

const roots: string[] = [];

const temporaryRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("the Windows PowerShell path", () => {
  it("uses the absolute path under SystemRoot instead of relying on PATH", () => {
    expect(resolvePowerShellPath({ SystemRoot: "C:\\Windows" }, "win32")).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("falls back to C:\\Windows when SystemRoot is absent", () => {
    expect(resolvePowerShellPath({}, "win32")).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("keeps the bare name on non-Windows platforms", () => {
    expect(resolvePowerShellPath({}, "linux")).toBe("powershell.exe");
  });
});

describe("the managed toolchain configuration", () => {
  it("reads an absent config as empty and round-trips a selection", async () => {
    const root = await temporaryRoot("uvp-toolchain-config-");
    const configPath = path.join(root, "toolchains.json");
    expect(await readToolchainConfig(configPath)).toEqual({
      schema: CONFIG_SCHEMA,
      mirrors: {},
      selected: {},
    });

    await writeToolchainConfig(configPath, {
      schema: CONFIG_SCHEMA,
      mirrors: { libuvcpp: "https://mirror.example/uvcpp/" },
      selected: { libuvcpp: { version: "1.11.0", variant: "linux-x64" } },
    });
    expect(await readToolchainConfig(configPath)).toEqual({
      schema: CONFIG_SCHEMA,
      mirrors: { libuvcpp: "https://mirror.example/uvcpp/" },
      selected: { libuvcpp: { version: "1.11.0", variant: "linux-x64" } },
    });
  });

  it("rejects a config that is not the declared schema", async () => {
    const root = await temporaryRoot("uvp-toolchain-config-");
    const configPath = path.join(root, "toolchains.json");
    await writeFile(configPath, '{"schema":"other/1"}\n', "utf8");
    await expect(readToolchainConfig(configPath)).rejects.toMatchObject({
      code: "config_invalid",
    });
  });
});

describe("installing a managed toolchain", () => {
  it("fails before extraction when the bytes do not match the pinned digest", async () => {
    const root = await temporaryRoot("uvp-toolchain-install-");
    const release = findRelease("libuvcpp", { version: "1.11.0", variant: "linux-x64" });
    expect(release).toBeDefined();
    if (release === undefined) return;

    await expect(
      installToolchain(
        { ...release, bytes: 1, sha256: "0".repeat(64) },
        {
          home: path.join(root, "toolchains"),
          configPath: path.join(root, "toolchains.json"),
          fetchBytes: async () => Buffer.from("x"),
        },
      ),
    ).rejects.toMatchObject({ code: "digest_mismatch" });

    expect(await pathExists(installPath(path.join(root, "toolchains"), release))).toBe(false);
  });

  it("rejects a download whose byte count disagrees with the catalog", async () => {
    const root = await temporaryRoot("uvp-toolchain-install-");
    const release = findRelease("libuvcpp", { version: "1.11.0", variant: "linux-x64" });
    expect(release).toBeDefined();
    if (release === undefined) return;

    await expect(
      installToolchain(
        { ...release, bytes: 2 },
        {
          home: path.join(root, "toolchains"),
          configPath: path.join(root, "toolchains.json"),
          fetchBytes: async () => Buffer.from("x"),
        },
      ),
    ).rejects.toMatchObject({ code: "size_mismatch" });
  });

  it("extracts a CMake archive, accepts its layout, and selects it", async () => {
    const root = await temporaryRoot("uvp-toolchain-cmake-");
    const fixture = path.join(root, "fixture");
    const top = path.join(fixture, "cmake-9.9.9-linux-x64");
    await mkdir(path.join(top, "bin"), { recursive: true });
    await writeFile(path.join(top, "bin", "cmake"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(top, "bin", "cmake"), 0o755);
    const archive = path.join(root, "cmake-9.9.9-linux-x64.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", fixture, "cmake-9.9.9-linux-x64"]);
    const bytes = await readFile(archive);
    const release = {
      id: "cmake@9.9.9:linux-x64",
      tool: "cmake" as const,
      version: "9.9.9",
      variant: "linux-x64" as const,
      asset: "cmake-9.9.9-linux-x64.tar.gz",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      archive: "tar.gz" as const,
      executable: "bin/cmake",
    };

    const home = path.join(root, "toolchains");
    const configPath = path.join(root, "toolchains.json");
    const result = await installToolchain(release, {
      home,
      configPath,
      fetchBytes: async () => bytes,
    });

    expect(result.installed.release.id).toBe("cmake@9.9.9:linux-x64");
    expect(result.installed.executable).toBe(
      path.join(home, "cmake", "9.9.9", "linux-x64", "bin", "cmake"),
    );
    expect(result.selected).toBe(true);
    expect(await readToolchainConfig(configPath)).toMatchObject({
      selected: { cmake: { version: "9.9.9", variant: "linux-x64" } },
    });
  });

  it("names an un catalogued release instead of choosing another version", async () => {
    await expect(
      installManaged("libuvcpp", { version: "9.9.9", variant: "linux-x64" }),
    ).rejects.toBeInstanceOf(ManagedToolchainError);
  });

  it("reuses an existing install for a repeat setup and still selects it", async () => {
    const root = await temporaryRoot("uvp-toolchain-reuse-");
    const home = path.join(root, "toolchains");
    const configPath = path.join(root, "toolchains.json");
    const release = findRelease("libuvcpp", { version: "1.11.0", variant: "linux-x64" });
    expect(release).toBeDefined();
    if (release === undefined) return;

    const target = installPath(home, release);
    await mkdir(path.join(target, "include", "uvcpp"), { recursive: true });
    await mkdir(path.join(target, "lib", "pkgconfig"), { recursive: true });
    await writeFile(path.join(target, "include", "uvcpp", "uvcpp_config.h"), "");
    await writeFile(path.join(target, "lib", "pkgconfig", "uvcpp.pc"), "");

    const result = await installToolchain(release, {
      home,
      configPath,
      reuse: true,
      fetchBytes: async () => {
        throw new Error("a reused install must not download");
      },
    });

    expect(result.reused).toBe(true);
    expect(result.selected).toBe(true);
    expect(result.installed.path).toBe(target);
    expect(await readToolchainConfig(configPath)).toMatchObject({
      selected: { libuvcpp: { version: "1.11.0", variant: "linux-x64" } },
    });
  });
});

describe("the synchronous selection used by the build", () => {
  it("reads a selected libuvcpp prefix and a selected CMake executable", async () => {
    const root = await temporaryRoot("uvp-toolchain-select-");
    const home = path.join(root, "toolchains");
    const configPath = path.join(root, "toolchains.json");
    const libuvcpp = findRelease("libuvcpp", { version: "1.11.0", variant: "linux-x64" });
    const cmake = findRelease("cmake", { version: "3.31.6", variant: "linux-x64" });
    expect(libuvcpp).toBeDefined();
    expect(cmake).toBeDefined();
    if (libuvcpp === undefined || cmake === undefined) return;

    const libuvcppPath = installPath(home, libuvcpp);
    await mkdir(path.join(libuvcppPath, "include", "uvcpp"), { recursive: true });
    await mkdir(path.join(libuvcppPath, "lib", "pkgconfig"), { recursive: true });
    await writeFile(path.join(libuvcppPath, "include", "uvcpp", "uvcpp_config.h"), "");
    await writeFile(path.join(libuvcppPath, "lib", "pkgconfig", "uvcpp.pc"), "");

    const cmakePath = installPath(home, cmake);
    await mkdir(path.join(cmakePath, "bin"), { recursive: true });
    await writeFile(path.join(cmakePath, "bin", "cmake"), "#!/bin/sh\n");
    await chmod(path.join(cmakePath, "bin", "cmake"), 0o755);

    await writeToolchainConfig(configPath, {
      schema: CONFIG_SCHEMA,
      mirrors: {},
      selected: {
        libuvcpp: { version: "1.11.0", variant: "linux-x64" },
        cmake: { version: "3.31.6", variant: "linux-x64" },
      },
    });

    const env = { UVP_TOOLCHAIN_HOME: home, UVP_TOOLCHAIN_CONFIG: configPath };
    expect(selectedLibuvcppPrefixSync(env, "/nonexistent")).toBe(libuvcppPath);
    expect(selectedCmakePathSync(env, "/nonexistent")).toBe(path.join(cmakePath, "bin", "cmake"));
  });

  it("returns undefined when the selection has no installed directory", async () => {
    const root = await temporaryRoot("uvp-toolchain-select-");
    const configPath = path.join(root, "toolchains.json");
    await writeToolchainConfig(configPath, {
      schema: CONFIG_SCHEMA,
      mirrors: {},
      selected: { libuvcpp: { version: "1.11.0", variant: "linux-x64" } },
    });
    const env = {
      UVP_TOOLCHAIN_HOME: path.join(root, "toolchains"),
      UVP_TOOLCHAIN_CONFIG: configPath,
    };
    expect(selectedLibuvcppPrefixSync(env, "/nonexistent")).toBeUndefined();
  });
});

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};
