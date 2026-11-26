/**
 * The toolchains uvp can install for a user.
 *
 * This is a closed catalog, not a live query. Every asset is pinned by version,
 * variant, byte count where known, and SHA-256, because the installer's promise
 * is that a downloaded archive is the archive uvp intended to run. A mirror may
 * serve the bytes, but it cannot change what they must hash to.
 *
 * Variants are the archive's own target names. They are not the host's names:
 * a Windows x64 host defaults to the MinGW archive (`mingw-x64`) while an MSVC
 * user can select `msvc-x64`, and a Linux host can keep a MinGW archive beside
 * its native one to cross-compile. `hostVariant` is only a default.
 */

export type ManagedToolName = "libuvcpp" | "cmake";

export const MANAGED_TOOL_NAMES: readonly ManagedToolName[] = ["libuvcpp", "cmake"];

export type LibuvcppVariant =
  | "linux-x64"
  | "linux-arm64"
  | "mingw-x64"
  | "mingw-arm64"
  | "msvc-x64"
  | "msvc-arm64";

export type CMakeVariant =
  | "linux-x64"
  | "linux-arm64"
  | "windows-x64"
  | "windows-arm64"
  | "macos-universal";

export type ToolchainVariant = LibuvcppVariant | CMakeVariant;

export interface ToolchainRelease {
  /** `tool@version:variant`, the spelling a caller can paste back. */
  readonly id: string;
  readonly tool: ManagedToolName;
  readonly version: string;
  readonly variant: ToolchainVariant;
  readonly asset: string;
  readonly sha256: string;
  /** Observed asset size; absent for assets whose size was not recorded. */
  readonly bytes?: number;
  readonly archive: "zip" | "tar.gz";
  /** The executable a caller should run, relative to the install root. */
  readonly executable?: string;
}

const LIBUVCPP_LATEST = "1.11.0";
const CMAKE_LATEST = "3.31.6";

type LibuvcppRow = readonly [
  version: string,
  variant: LibuvcppVariant,
  bytes: number,
  sha256: string,
];

const LIBUVCPP_ROWS: readonly LibuvcppRow[] = [
  [
    "1.11.0",
    "linux-arm64",
    30054801,
    "8b9aa0678938d2306b721e8fc46d0f46976d5e1a776510bfa0c92281857016bc",
  ],
  [
    "1.11.0",
    "linux-x64",
    29897763,
    "e74fe6f4f5478ddec4fa1bc68cdfa51801ff2d42bb520f37e67be571544877fb",
  ],
  [
    "1.11.0",
    "mingw-arm64",
    24693866,
    "d04e128f0d76e8b882c95f0eada455eee11ba5a830b6d024e78e002edc67ae50",
  ],
  [
    "1.11.0",
    "mingw-x64",
    32761090,
    "65973cbe32d3c2dfc8fcc1807fd4059f4f1af5049fccedc10445beb27ab601ce",
  ],
  [
    "1.11.0",
    "msvc-arm64",
    27105620,
    "1065b18fb8dde4a758ca50acc313cbbc0a5082896a2c2919a9e3eec5be14c41f",
  ],
  [
    "1.11.0",
    "msvc-x64",
    26053209,
    "c8a500e0821fc4484d05e7bcf16c536630cb4d7fe7f5f4b650565a37bd2275aa",
  ],
  [
    "1.10.0",
    "linux-arm64",
    29454750,
    "57e881f600eb50a9ae1c2915184116fee73429c11203af434d9a923f5f7864ec",
  ],
  [
    "1.10.0",
    "linux-x64",
    29290685,
    "c7dfcdd0d70e81e4f6a2833d5006f5b8c6b719fdaf97dd5f1d41b85012888993",
  ],
  [
    "1.10.0",
    "mingw-arm64",
    24204677,
    "4029a1e3107fa81ca5f338167858faa1d74f41213dd80a9e7457a8c06c85f62f",
  ],
  [
    "1.10.0",
    "mingw-x64",
    32064565,
    "17efc2f51fa362eb0f2f182bea899c9f776a65db4f8372f165cdf984d8b70a92",
  ],
  [
    "1.10.0",
    "msvc-arm64",
    26543223,
    "ff6c776acf67839103d790847efdca96a2ceeb8bdd2be12584051d1a6fafa51f",
  ],
  [
    "1.10.0",
    "msvc-x64",
    25492160,
    "abaa0dea442aade912b34ea83a6a496af22a8a4c9718ef841a81731095b20877",
  ],
  [
    "1.9.1",
    "linux-arm64",
    28024734,
    "9d6a7b3e4658796c77e5065ca189ad9e7420e7ad23a8aa34de683d2fbc529c95",
  ],
  [
    "1.9.1",
    "linux-x64",
    27838148,
    "47c0d3ddd865674f612a8fb5f91a50bb03631ab75734776da98ed5cd03f8171a",
  ],
  [
    "1.9.1",
    "mingw-arm64",
    23017356,
    "b7c3cb8f0850d33ee5e939791dc13f04b8d2d987a87df5bf10975f986cdadfbe",
  ],
  [
    "1.9.1",
    "mingw-x64",
    30310777,
    "254cc8ab7cf1e0e1919f5ccec23f539df0bfc0c763869a159f40ca5901463430",
  ],
  [
    "1.9.1",
    "msvc-arm64",
    25327239,
    "13da7ae7c62cf72fcbcb20b7f22d76cd5832ece80f9c81bb385b419b24189e4e",
  ],
  [
    "1.9.1",
    "msvc-x64",
    24360119,
    "90c9156f6243711598e22d30fbbd6dca844220ddb3fc68702db27f7cb5c95799",
  ],
  [
    "1.7.0",
    "linux-arm64",
    25178551,
    "2061b3ad0a80849612cc92430c1771bd5bfcacf0de3d2765aaef348020dcd65d",
  ],
  [
    "1.7.0",
    "linux-x64",
    24916745,
    "6e084a8ade83408ca49294091761c72c4973d07da726fe04195a25235d17ae02",
  ],
  [
    "1.7.0",
    "mingw-arm64",
    20763461,
    "7a60558da11acdc03f1735fe2e55d2542c52516b6c6a941bca7b9d3fe74d4eb8",
  ],
  [
    "1.7.0",
    "mingw-x64",
    27133260,
    "5e9877d9023b8cd049cc5fa993b4e2bf39d20775b9c67f10c05dfd8ac6558616",
  ],
  [
    "1.7.0",
    "msvc-arm64",
    22718587,
    "743d4e467590555134fa13dd1441037fbeb725737d1bf492d1e5d68a628145b6",
  ],
  [
    "1.7.0",
    "msvc-x64",
    21800490,
    "9b7b5daedc23420494d60348b20939b97fe2c947df3e5bbb3fbd2cd93b3e153b",
  ],
];

type CMakeRow = readonly [
  version: string,
  variant: CMakeVariant,
  assetSuffix: string,
  sha256: string,
];

const CMAKE_ROWS: readonly CMakeRow[] = [
  [
    "3.31.6",
    "linux-x64",
    "linux-x86_64.tar.gz",
    "5a1133ff103c71eb5120e2cc3de922733e7d8a26a98ae716397e8676adb367bf",
  ],
  [
    "3.31.6",
    "linux-arm64",
    "linux-aarch64.tar.gz",
    "b4cc788d63112b2749b40627e719eb5d3b8ed8f00c36d77189f4019cfe64bc9e",
  ],
  [
    "3.31.6",
    "windows-x64",
    "windows-x86_64.zip",
    "d163cd3ab4959b0a53fa8988f2ddbd2e6c501658201e6a154386bad9dbe4f836",
  ],
  [
    "3.31.6",
    "windows-arm64",
    "windows-arm64.zip",
    "fa648fd417f44e6cb08928964a480ade0d18df421f9b623639dba22f9b301e4e",
  ],
  [
    "3.31.6",
    "macos-universal",
    "macos-universal.tar.gz",
    "330b9514f5112e5ed4fb08b8b05803b776fd9b539a6ae12927d14dcc0ee2ba8d",
  ],
  [
    "4.0.3",
    "linux-x64",
    "linux-x86_64.tar.gz",
    "585ae9e013107bc8e7c7c9ce872cbdcbdff569e675b07ef57aacfb88c886faac",
  ],
  [
    "4.0.3",
    "linux-arm64",
    "linux-aarch64.tar.gz",
    "391da1544ef50ac31300841caaf11db4de3976cdc4468643272e44b3f4644713",
  ],
  [
    "4.0.3",
    "windows-x64",
    "windows-x86_64.zip",
    "b59a31dfbfa376a4aaea9ff560ff2b29f78ee5f9fb15447fc71ae7bf9fea9379",
  ],
  [
    "4.0.3",
    "windows-arm64",
    "windows-arm64.zip",
    "86ccd6485bbd4bb41a1a858db397be5bca5e0de96858bf8dbba7a64407bd6c00",
  ],
  [
    "4.0.3",
    "macos-universal",
    "macos-universal.tar.gz",
    "4e85de4daf1c3e82d7dc6b8ba5683972944b466343aeb9c327a742437bb3ce9a",
  ],
];

const libuvcppRelease = ([version, variant, bytes, sha256]: LibuvcppRow): ToolchainRelease => {
  const asset = `libuvcpp-${version}-${variant}.zip`;
  return {
    id: `libuvcpp@${version}:${variant}`,
    tool: "libuvcpp",
    version,
    variant,
    asset,
    sha256,
    bytes,
    archive: "zip",
  };
};

const cmakeRelease = ([version, variant, suffix, sha256]: CMakeRow): ToolchainRelease => {
  const asset = `cmake-${version}-${suffix}`;
  return {
    id: `cmake@${version}:${variant}`,
    tool: "cmake",
    version,
    variant,
    asset,
    sha256,
    archive: suffix.endsWith(".zip") ? "zip" : "tar.gz",
    executable: variant.startsWith("windows-") ? "bin/cmake.exe" : "bin/cmake",
  };
};

export const TOOLCHAIN_CATALOG: readonly ToolchainRelease[] = [
  ...LIBUVCPP_ROWS.map(libuvcppRelease),
  ...CMAKE_ROWS.map(cmakeRelease),
];

export const LATEST_TOOLCHAIN_VERSION: Readonly<Record<ManagedToolName, string>> = {
  libuvcpp: LIBUVCPP_LATEST,
  cmake: CMAKE_LATEST,
};

export const DEFAULT_VARIANTS: Readonly<Record<ManagedToolName, readonly ToolchainVariant[]>> = {
  libuvcpp: ["linux-x64", "linux-arm64", "mingw-x64", "mingw-arm64", "msvc-x64", "msvc-arm64"],
  cmake: ["linux-x64", "linux-arm64", "windows-x64", "windows-arm64", "macos-universal"],
};

export const TOOLCHAIN_VERSIONS: Readonly<Record<ManagedToolName, readonly string[]>> = {
  libuvcpp: [...new Set(LIBUVCPP_ROWS.map((row) => row[0]))],
  cmake: [...new Set(CMAKE_ROWS.map((row) => row[0]))],
};

export const releasesFor = (
  tool: ManagedToolName,
  options: { readonly version?: string; readonly variant?: ToolchainVariant } = {},
): readonly ToolchainRelease[] =>
  TOOLCHAIN_CATALOG.filter(
    (release) =>
      release.tool === tool &&
      (options.version === undefined || release.version === options.version) &&
      (options.variant === undefined || release.variant === options.variant),
  );

export const findRelease = (
  tool: ManagedToolName,
  options: { readonly version?: string; readonly variant?: ToolchainVariant } = {},
): ToolchainRelease | undefined => releasesFor(tool, options)[0];

export const variantsFor = (tool: ManagedToolName): readonly ToolchainVariant[] =>
  DEFAULT_VARIANTS[tool];

/** The archive a host of this shape gets when the caller names no variant. */
export const hostVariant = (
  tool: ManagedToolName,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ToolchainVariant | undefined => {
  const bits = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  if (bits === undefined) return undefined;
  if (tool === "libuvcpp") {
    if (platform === "linux") return bits === "arm64" ? "linux-arm64" : "linux-x64";
    // The owner's default on Windows is the MinGW archive; MSVC remains an
    // explicit choice because it needs a Visual Studio toolset, not just a DLL.
    if (platform === "win32") return bits === "arm64" ? "mingw-arm64" : "mingw-x64";
    return undefined;
  }
  if (platform === "linux") return bits === "arm64" ? "linux-arm64" : "linux-x64";
  if (platform === "win32") return bits === "arm64" ? "windows-arm64" : "windows-x64";
  if (platform === "darwin") return "macos-universal";
  return undefined;
};

export const defaultRelease = (
  tool: ManagedToolName,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ToolchainRelease | undefined => {
  const variant = hostVariant(tool, platform, arch);
  return variant === undefined
    ? undefined
    : findRelease(tool, { version: LATEST_TOOLCHAIN_VERSION[tool], variant });
};

const toolDefaultBase = (release: ToolchainRelease): string => {
  if (release.tool === "libuvcpp") {
    return "https://github.com/Antruly/libuvcpp/releases/download/v{version}/{asset}";
  }
  // GitHub serves the same release assets as cmake.org and is the default the
  // owner asked for; a mirror template can point at cmake.org or an internal
  // copy. The SHA-256 in the catalog is what makes either source equivalent.
  return "https://github.com/Kitware/CMake/releases/download/v{version}/{asset}";
};

/**
 * The download URL for one release, optionally through a mirror.
 *
 * A mirror may be a full template with `{version}`, `{variant}`, `{asset}`, or a
 * directory URL. A directory is the common mirror shape: the same asset name is
 * served under a different host. No placeholder means "append the asset name".
 */
export const releaseUrl = (release: ToolchainRelease, mirror?: string): string => {
  const template =
    mirror === undefined || mirror.trim() === "" ? toolDefaultBase(release) : mirror.trim();
  let url = template
    .replaceAll("{version}", release.version)
    .replaceAll("{variant}", release.variant)
    .replaceAll("{asset}", release.asset)
    .replaceAll("{tool}", release.tool);
  if (!template.includes("{asset}")) {
    url = `${url.replace(/\/+$/u, "")}/${release.asset}`;
  }
  return url;
};

export const parseToolchainReference = (
  value: string,
): {
  readonly tool: ManagedToolName;
  readonly version?: string;
  readonly variant?: ToolchainVariant;
} => {
  const at = value.indexOf("@");
  const tool = (at === -1 ? value : value.slice(0, at)) as ManagedToolName;
  if (!MANAGED_TOOL_NAMES.includes(tool)) {
    throw new Error(`unknown toolchain '${value}'; expected libuvcpp or cmake`);
  }
  const rest = at === -1 ? "" : value.slice(at + 1);
  const colon = rest.indexOf(":");
  const version = colon === -1 ? rest : rest.slice(0, colon);
  const variant = colon === -1 ? undefined : rest.slice(colon + 1);
  return {
    tool,
    ...(version === "" ? {} : { version }),
    ...(variant === undefined || variant === "" ? {} : { variant: variant as ToolchainVariant }),
  };
};
