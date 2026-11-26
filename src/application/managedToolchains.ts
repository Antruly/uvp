import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, constants as fsConstants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { isRecord } from "../domain/templatePackageProblems.js";
import {
  LATEST_TOOLCHAIN_VERSION,
  TOOLCHAIN_CATALOG,
  defaultRelease,
  findRelease,
  hostVariant,
  releaseUrl,
  type ManagedToolName,
  type ToolchainRelease,
  type ToolchainVariant,
} from "../domain/toolchainCatalog.js";

/**
 * Install and select the C++ toolchains uvp uses (#307, #310).
 *
 * The installer owns a directory per `tool/version/variant` and a config file
 * that names the selection. It never edits a shell profile and never replaces a
 * system install. `uvp build` and `uvp doctor` read the selection through the
 * same file, so what the installer reports and what the build links cannot
 * disagree.
 *
 * Downloads are pinned by SHA-256 in the catalog. A mirror may change where the
 * bytes come from; it cannot change what they must hash to. An archive is
 * extracted into a temporary directory, checked for links and for the layout the
 * tool must have, and only then moved into its final path.
 */

const execFileAsync = promisify(execFile);

export const CONFIG_SCHEMA = "uvp.toolchains/1";
const METADATA_NAME = ".uvp-toolchain.json";

export class ManagedToolchainError extends Error {
  readonly code:
    | "unknown_release"
    | "already_installed"
    | "download_failed"
    | "size_mismatch"
    | "digest_mismatch"
    | "extract_failed"
    | "layout_invalid"
    | "not_installed"
    | "config_invalid"
    | "io_error";
  readonly details: readonly string[];

  constructor(
    code: ManagedToolchainError["code"],
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "ManagedToolchainError";
    this.code = code;
    this.details = details;
  }
}

export interface ToolchainSelection {
  readonly version: string;
  readonly variant: ToolchainVariant;
}

export interface ManagedToolchainConfig {
  readonly schema: typeof CONFIG_SCHEMA;
  readonly mirrors: Partial<Record<ManagedToolName, string>>;
  readonly selected: Partial<Record<ManagedToolName, ToolchainSelection>>;
}

export interface InstalledToolchain {
  readonly release: ToolchainRelease;
  readonly path: string;
  readonly executable?: string;
}

export interface ManagedStatus {
  readonly home: string;
  readonly configPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly hostVariants: Partial<Record<ManagedToolName, ToolchainVariant>>;
  readonly selected: Partial<Record<ManagedToolName, ToolchainSelection>>;
  readonly installed: readonly InstalledToolchain[];
  readonly mirrors: Partial<Record<ManagedToolName, string>>;
}

export interface InstallOptions {
  readonly home?: string;
  readonly configPath?: string;
  readonly mirror?: string;
  readonly force?: boolean;
  readonly select?: boolean;
  /** Reuse an existing install instead of failing with `already_installed`. */
  readonly reuse?: boolean;
  readonly timeoutMs?: number;
  /** A seam for tests; the default downloads over http(s). */
  readonly fetchBytes?: (url: string, maxBytes: number) => Promise<Buffer>;
}

export interface InstallResult {
  readonly installed: InstalledToolchain;
  readonly url: string;
  readonly selected: boolean;
  /** True when no bytes were downloaded because the install already existed. */
  readonly reused?: boolean;
}

const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error["code"] === "string" ? error["code"] : undefined;

const ioError = (message: string, error: unknown): ManagedToolchainError =>
  new ManagedToolchainError("io_error", `${message}: ${errorCode(error) ?? String(error)}`);

export const resolveToolchainHome = (
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string => {
  const configured = env["UVP_TOOLCHAIN_HOME"];
  return path.resolve(
    configured !== undefined && configured.trim() !== ""
      ? configured
      : path.join(home, ".uvp", "toolchains"),
  );
};

export const resolveToolchainConfigPath = (
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string => {
  const configured = env["UVP_TOOLCHAIN_CONFIG"];
  return path.resolve(
    configured !== undefined && configured.trim() !== ""
      ? configured
      : path.join(home, ".uvp", "toolchains.json"),
  );
};

const emptyConfig = (): ManagedToolchainConfig => ({
  schema: CONFIG_SCHEMA,
  mirrors: {},
  selected: {},
});

export const readToolchainConfig = async (configPath: string): Promise<ManagedToolchainConfig> => {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return emptyConfig();
    throw ioError(`could not read ${configPath}`, error);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ManagedToolchainError("config_invalid", `${configPath} is not JSON`);
  }
  if (!isRecord(raw) || raw["schema"] !== CONFIG_SCHEMA) {
    throw new ManagedToolchainError(
      "config_invalid",
      `${configPath} is not a ${CONFIG_SCHEMA} file`,
    );
  }
  const mirrors: Partial<Record<ManagedToolName, string>> = {};
  const selected: Partial<Record<ManagedToolName, ToolchainSelection>> = {};
  const rawMirrors = isRecord(raw["mirrors"]) ? raw["mirrors"] : {};
  for (const tool of ["libuvcpp", "cmake"] as const) {
    const value = rawMirrors[tool];
    if (typeof value === "string" && value.trim() !== "") mirrors[tool] = value;
  }
  const rawSelected = isRecord(raw["selected"]) ? raw["selected"] : {};
  for (const tool of ["libuvcpp", "cmake"] as const) {
    const value = rawSelected[tool];
    if (
      isRecord(value) &&
      typeof value["version"] === "string" &&
      typeof value["variant"] === "string"
    ) {
      selected[tool] = {
        version: value["version"],
        variant: value["variant"] as ToolchainVariant,
      };
    }
  }
  return { schema: CONFIG_SCHEMA, mirrors, selected };
};

export const writeToolchainConfig = async (
  configPath: string,
  config: ManagedToolchainConfig,
): Promise<void> => {
  await mkdir(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(temporary, configPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw ioError(`could not write ${configPath}`, error);
  }
};

export const installPath = (home: string, release: ToolchainRelease): string =>
  path.join(home, release.tool, release.version, release.variant);

const executablePath = (root: string, release: ToolchainRelease): string | undefined =>
  release.executable === undefined ? undefined : path.join(root, release.executable);

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

/** The layout each tool must have before its directory is accepted. */
const validateLayout = async (root: string, release: ToolchainRelease): Promise<void> => {
  if (release.tool === "libuvcpp") {
    const header = path.join(root, "include", "uvcpp", "uvcpp_config.h");
    const pc = path.join(root, "lib", "pkgconfig", "uvcpp.pc");
    if (!(await pathExists(header)) || !(await pathExists(pc))) {
      throw new ManagedToolchainError(
        "layout_invalid",
        `${release.id} does not contain include/uvcpp/uvcpp_config.h and lib/pkgconfig/uvcpp.pc`,
      );
    }
    return;
  }
  const executable = executablePath(root, release);
  if (executable === undefined || !(await pathExists(executable))) {
    throw new ManagedToolchainError(
      "layout_invalid",
      `${release.id} does not contain ${release.executable ?? "its executable"}`,
    );
  }
  if (process.platform !== "win32") {
    try {
      await access(executable, fsConstants.X_OK);
    } catch {
      throw new ManagedToolchainError("layout_invalid", `${executable} is not executable`);
    }
  }
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Read a response body with a hard cap.
 *
 * `arrayBuffer()` would allocate the whole body before the size check, so a
 * mirror that answers with a huge body would be a memory problem before it was a
 * verification problem. The cap is the larger of the catalog's byte count and a
 * small slack, because a mirror may add a wrapper; the digest remains the
 * authority.
 */
const readBoundedBody = async (response: Response, maxBytes: number): Promise<Buffer> => {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new ManagedToolchainError(
      "size_mismatch",
      `the download declares ${declared} bytes; at most ${maxBytes} are expected`,
    );
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ManagedToolchainError(
        "size_mismatch",
        `the download is larger than ${maxBytes} bytes`,
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
};

export const defaultFetchBytes = async (url: string, maxBytes: number): Promise<Buffer> => {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      if (!response.ok) {
        // 404/403 will not improve on retry; 5xx and 429 may.
        if (response.status < 500 && response.status !== 429) {
          throw new ManagedToolchainError(
            "download_failed",
            `the download answered HTTP ${response.status}: ${url}`,
          );
        }
        throw new Error(`HTTP ${response.status}`);
      }
      return await readBoundedBody(response, maxBytes);
    } catch (error) {
      last = error;
      if (error instanceof ManagedToolchainError) throw error;
      if (attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new ManagedToolchainError("download_failed", `could not download ${url}: ${String(last)}`);
};

const quotePowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const listArchive = async (
  archive: string,
  release: ToolchainRelease,
): Promise<readonly string[]> => {
  const cmake = await findOnPath("cmake");
  if (cmake !== undefined) {
    try {
      const { stdout } = await execFileAsync(cmake, ["-E", "tar", "tf", archive], {
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout.split(/\r?\n/u).filter((line) => line !== "");
    } catch {
      // Fall through to the platform tool.
    }
  }
  if (release.archive === "tar.gz") {
    const { stdout } = await execFileAsync("tar", ["-tzf", archive]);
    return stdout.split(/\r?\n/u).filter((line) => line !== "");
  }
  if (process.platform !== "win32") {
    const { stdout } = await execFileAsync("unzip", ["-Z1", archive]);
    return stdout.split(/\r?\n/u).filter((line) => line !== "");
  }
  return [];
};

const findOnPath = async (name: string): Promise<string | undefined> => {
  const pathValue = process.env["PATH"];
  if (pathValue === undefined) return undefined;
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory === "") continue;
    for (const suffix of process.platform === "win32" ? [".exe", ""] : [""]) {
      const candidate = path.join(directory, name + suffix);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
};

const archivePathProblem = (entry: string): string | undefined => {
  const normalized = entry.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    return "is absolute";
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    return "contains a '..' segment";
  }
  return undefined;
};

const extractArchive = async (
  archive: string,
  destination: string,
  release: ToolchainRelease,
): Promise<void> => {
  const entries = await listArchive(archive, release);
  for (const entry of entries) {
    const problem = archivePathProblem(entry);
    if (problem !== undefined) {
      throw new ManagedToolchainError("extract_failed", `the archive entry '${entry}' ${problem}`);
    }
  }

  if (release.archive === "zip" && process.platform === "win32") {
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${quotePowerShell(archive)} -DestinationPath ${quotePowerShell(destination)} -Force`,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return;
  }

  const cmake = await findOnPath("cmake");
  if (cmake !== undefined) {
    try {
      await execFileAsync(cmake, ["-E", "tar", "xf", archive], { cwd: destination });
      return;
    } catch {
      // Fall through to the native tool.
    }
  }
  if (release.archive === "tar.gz") {
    await execFileAsync("tar", ["-xzf", archive, "-C", destination]);
    return;
  }
  await execFileAsync("unzip", ["-q", archive, "-d", destination]);
};

const rejectLinks = async (root: string): Promise<void> => {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new ManagedToolchainError(
        "layout_invalid",
        `the archive contains a symlink: ${entry.name}`,
      );
    }
    if (entry.isDirectory()) await rejectLinks(path.join(root, entry.name));
  }
};

const onlyChildDirectory = async (root: string): Promise<string> => {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length === 1 && entries[0]?.isDirectory() === true) {
    return path.join(root, entries[0].name);
  }
  return root;
};

export const installToolchain = async (
  release: ToolchainRelease,
  options: InstallOptions = {},
): Promise<InstallResult> => {
  const home = options.home ?? resolveToolchainHome();
  const configPath = options.configPath ?? resolveToolchainConfigPath();
  const config = await readToolchainConfig(configPath);
  const envMirror =
    release.tool === "libuvcpp"
      ? process.env["UVP_LIBUVCPP_MIRROR"]
      : process.env["UVP_CMAKE_MIRROR"];
  const mirror =
    options.mirror ??
    (envMirror !== undefined && envMirror.trim() !== "" ? envMirror : undefined) ??
    config.mirrors[release.tool];
  const url = releaseUrl(release, mirror);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ManagedToolchainError("download_failed", `'${url}' is not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ManagedToolchainError("download_failed", `'${url}' is not an http or https URL`);
  }

  const target = installPath(home, release);
  if ((await pathExists(target)) && options.force !== true) {
    if (options.reuse !== true) {
      throw new ManagedToolchainError(
        "already_installed",
        `${release.id} is already installed at ${target}`,
      );
    }
    // `uvp env` is safe to run again: the wizard reuses the bytes it already
    // owns, but still records the selection so a fresh shell picks them up. The
    // layout is checked again — a directory that exists is not necessarily an
    // install, and selecting a half-removed tree would make the next build fail
    // somewhere less obvious.
    await validateLayout(target, release);
    const selects = options.select !== false;
    const savesMirror = options.mirror !== undefined && options.mirror.trim() !== "";
    if (selects || savesMirror) {
      await writeToolchainConfig(configPath, {
        ...config,
        selected: selects
          ? {
              ...config.selected,
              [release.tool]: { version: release.version, variant: release.variant },
            }
          : config.selected,
        mirrors: savesMirror
          ? { ...config.mirrors, [release.tool]: options.mirror as string }
          : config.mirrors,
      });
    }
    return {
      installed: {
        release,
        path: target,
        ...(release.executable === undefined
          ? {}
          : { executable: path.join(target, release.executable) }),
      },
      url: "",
      selected: selects,
      reused: true,
    };
  }

  const stagingRoot = path.join(home, ".tmp");
  await mkdir(stagingRoot, { recursive: true });
  const work = await mkdtemp(path.join(stagingRoot, "install-"));
  const archive = path.join(work, release.asset);
  try {
    const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
    const maxBytes = (release.bytes ?? 512 * 1024 * 1024) + 1024;
    const bytes = await fetchBytes(url, maxBytes);
    if (release.bytes !== undefined && bytes.byteLength !== release.bytes) {
      throw new ManagedToolchainError(
        "size_mismatch",
        `${release.id} is ${bytes.byteLength} bytes; the catalog says ${release.bytes}`,
      );
    }
    const digest = sha256(bytes);
    if (digest !== release.sha256) {
      throw new ManagedToolchainError(
        "digest_mismatch",
        `${release.id} has SHA-256 ${digest}; the catalog pins ${release.sha256}`,
      );
    }
    await writeFile(archive, bytes);

    const extraction = path.join(work, "extract");
    await mkdir(extraction);
    try {
      await extractArchive(archive, extraction, release);
    } catch (error) {
      if (error instanceof ManagedToolchainError) throw error;
      throw new ManagedToolchainError("extract_failed", `could not extract ${release.asset}`, [
        String(error),
      ]);
    }
    await rejectLinks(extraction);
    const root = await onlyChildDirectory(extraction);
    await validateLayout(root, release);

    if (await pathExists(target)) {
      await rm(target, { recursive: true, force: true });
    }
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await rename(root, target);
    } catch (error) {
      if (errorCode(error) !== "EXDEV")
        throw ioError(`could not move ${release.id} into place`, error);
      await cp(root, target, { recursive: true });
    }
    await writeFile(
      path.join(target, METADATA_NAME),
      `${JSON.stringify(
        {
          schema: "uvp.toolchain/1",
          tool: release.tool,
          version: release.version,
          variant: release.variant,
          asset: release.asset,
          sha256: release.sha256,
          bytes: bytes.byteLength,
          url,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const installed: InstalledToolchain = {
      release,
      path: target,
      ...(release.executable === undefined
        ? {}
        : { executable: path.join(target, release.executable) }),
    };
    const selects = options.select !== false;
    const savesMirror = options.mirror !== undefined && options.mirror.trim() !== "";
    if (selects || savesMirror) {
      const selected = selects
        ? {
            ...config.selected,
            [release.tool]: { version: release.version, variant: release.variant },
          }
        : config.selected;
      const mirrors = savesMirror
        ? { ...config.mirrors, [release.tool]: options.mirror as string }
        : config.mirrors;
      await writeToolchainConfig(configPath, { ...config, selected, mirrors });
    }
    return { installed, url, selected: selects };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
};

export const installManaged = async (
  tool: ManagedToolName,
  options: InstallOptions & { readonly version?: string; readonly variant?: ToolchainVariant } = {},
): Promise<InstallResult> => {
  const variant =
    options.variant ??
    hostVariant(tool) ??
    findRelease(tool, {
      ...(options.version === undefined ? {} : { version: options.version }),
    })?.variant;
  const release = findRelease(tool, {
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(variant === undefined ? {} : { variant }),
  });
  if (release === undefined) {
    throw new ManagedToolchainError(
      "unknown_release",
      `no ${tool} release is catalogued for ${options.version ?? LATEST_TOOLCHAIN_VERSION[tool]}${variant === undefined ? "" : ` ${variant}`}`,
    );
  }
  return installToolchain(release, options);
};

export const listInstalled = async (
  options: { readonly home?: string } = {},
): Promise<readonly InstalledToolchain[]> => {
  const home = options.home ?? resolveToolchainHome();
  const installed: InstalledToolchain[] = [];
  for (const release of TOOLCHAIN_CATALOG) {
    const target = installPath(home, release);
    if (await pathExists(target)) {
      installed.push({
        release,
        path: target,
        ...(release.executable === undefined
          ? {}
          : { executable: path.join(target, release.executable) }),
      });
    }
  }
  return installed;
};

export const selectManaged = async (
  tool: ManagedToolName,
  selection: ToolchainSelection,
  options: { readonly home?: string; readonly configPath?: string } = {},
): Promise<void> => {
  const release = findRelease(tool, selection);
  if (release === undefined) {
    throw new ManagedToolchainError(
      "unknown_release",
      `${tool}@${selection.version}:${selection.variant} is not catalogued`,
    );
  }
  const home = options.home ?? resolveToolchainHome();
  const target = installPath(home, release);
  if (!(await pathExists(target))) {
    throw new ManagedToolchainError(
      "not_installed",
      `${release.id} is not installed; run uvp env install ${tool}@${selection.version} --variant ${selection.variant}`,
    );
  }
  await validateLayout(target, release);
  const configPath = options.configPath ?? resolveToolchainConfigPath();
  const config = await readToolchainConfig(configPath);
  await writeToolchainConfig(configPath, {
    ...config,
    selected: { ...config.selected, [tool]: selection },
  });
};

export const removeManaged = async (
  tool: ManagedToolName,
  options: {
    readonly version?: string;
    readonly variant?: ToolchainVariant;
    readonly home?: string;
    readonly configPath?: string;
  } = {},
): Promise<string> => {
  const home = options.home ?? resolveToolchainHome();
  const configPath = options.configPath ?? resolveToolchainConfigPath();
  const config = await readToolchainConfig(configPath);
  const candidates = TOOLCHAIN_CATALOG.filter(
    (release) =>
      release.tool === tool &&
      (options.version === undefined || release.version === options.version) &&
      (options.variant === undefined || release.variant === options.variant),
  );
  const existing: ToolchainRelease[] = [];
  for (const release of candidates) {
    if (await pathExists(installPath(home, release))) existing.push(release);
  }
  if (existing.length === 0) {
    throw new ManagedToolchainError(
      "not_installed",
      `${tool}${options.version === undefined ? "" : `@${options.version}`} is not installed`,
    );
  }
  for (const release of existing) {
    await rm(installPath(home, release), { recursive: true, force: true });
  }
  const selected = config.selected[tool];
  const stillSelected = existing.some(
    (release) => selected?.version === release.version && selected?.variant === release.variant,
  );
  if (stillSelected) {
    const next = { ...config.selected };
    delete next[tool];
    await writeToolchainConfig(configPath, { ...config, selected: next });
  }
  return existing.map((release) => release.id).join(", ");
};

export const setMirror = async (
  tool: ManagedToolName,
  mirror: string,
  options: { readonly configPath?: string } = {},
): Promise<void> => {
  const configPath = options.configPath ?? resolveToolchainConfigPath();
  const config = await readToolchainConfig(configPath);
  const trimmed = mirror.trim();
  const nextMirrors = { ...config.mirrors };
  if (trimmed === "") delete nextMirrors[tool];
  else nextMirrors[tool] = trimmed;
  await writeToolchainConfig(configPath, { ...config, mirrors: nextMirrors });
};

export const managedStatus = async (
  options: { readonly home?: string; readonly configPath?: string } = {},
): Promise<ManagedStatus> => {
  const home = options.home ?? resolveToolchainHome();
  const configPath = options.configPath ?? resolveToolchainConfigPath();
  const config = await readToolchainConfig(configPath);
  const installed = await listInstalled({ home });
  const hostVariants: Partial<Record<ManagedToolName, ToolchainVariant>> = {};
  for (const tool of ["libuvcpp", "cmake"] as const) {
    const variant = hostVariant(tool);
    if (variant !== undefined) hostVariants[tool] = variant;
  }
  return {
    home,
    configPath,
    platform: process.platform,
    arch: process.arch,
    hostVariants,
    selected: config.selected,
    installed,
    mirrors: config.mirrors,
  };
};

/** The prefix a build should use, read synchronously by the toolchain provider. */
export const selectedLibuvcppPrefixSync = (
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | undefined => {
  try {
    const configPath = resolveToolchainConfigPath(env, home);
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (!isRecord(raw) || !isRecord(raw["selected"])) return undefined;
    const selected = raw["selected"]["libuvcpp"];
    if (!isRecord(selected)) return undefined;
    const { version, variant } = selected;
    if (typeof version !== "string" || typeof variant !== "string") return undefined;
    const release = findRelease("libuvcpp", { version, variant: variant as ToolchainVariant });
    if (release === undefined) return undefined;
    const prefix = installPath(resolveToolchainHome(env, home), release);
    return existsSync(prefix) ? prefix : undefined;
  } catch {
    return undefined;
  }
};

/** The CMake executable a build should run, read synchronously. */
export const selectedCmakePathSync = (
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | undefined => {
  try {
    const configPath = resolveToolchainConfigPath(env, home);
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (!isRecord(raw) || !isRecord(raw["selected"])) return undefined;
    const selected = raw["selected"]["cmake"];
    if (!isRecord(selected)) return undefined;
    const { version, variant } = selected;
    if (typeof version !== "string" || typeof variant !== "string") return undefined;
    const release = findRelease("cmake", { version, variant: variant as ToolchainVariant });
    if (release === undefined || release.executable === undefined) return undefined;
    const executable = path.join(
      installPath(resolveToolchainHome(env, home), release),
      release.executable,
    );
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
};
