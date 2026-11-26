import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { delimiter, dirname } from "node:path";

import { asBoolean, asString } from "../args.js";
import type { CommandSpec, LocalRunContext } from "../commandSpec.js";
import { EXIT_NO, EXIT_OK } from "../exitCodes.js";
import {
  ManagedToolchainError,
  installManaged,
  listInstalled,
  managedStatus,
  removeManaged,
  selectManaged,
  setMirror,
  type InstallResult,
} from "../../application/managedToolchains.js";
import {
  LATEST_TOOLCHAIN_VERSION,
  TOOLCHAIN_CATALOG,
  TOOLCHAIN_VERSIONS,
  defaultRelease,
  findRelease,
  hostVariant,
  parseToolchainReference,
  type ManagedToolName,
  type ToolchainVariant,
} from "../../domain/toolchainCatalog.js";

/**
 * `uvp env` — the dependency setup a new user runs after `npm install -g uvp`.
 *
 * No action starts the guided setup: it proposes the newest supported libuvcpp
 * and CMake for this host, and every question has a default, so pressing Enter
 * through the prompts is a complete install. `--yes` is the same flow without
 * prompts; `--json` is the machine-readable report, never a prompt.
 *
 * The command is local rather than a tool contract because prompting is its
 * interface. The same application functions back a future MCP tool without
 * changing this layer.
 */

const ask = async (
  reader: ReturnType<typeof createInterface>,
  question: string,
  fallback: string,
): Promise<string> => {
  const answer = (await reader.question(`${question} [${fallback}]: `)).trim();
  return answer === "" ? fallback : answer;
};

const askYesNo = async (
  reader: ReturnType<typeof createInterface>,
  question: string,
  fallback: boolean,
): Promise<boolean> => {
  const suffix = fallback ? "Y/n" : "y/N";
  const answer = (await reader.question(`${question} [${suffix}]: `)).trim().toLowerCase();
  if (answer === "") return fallback;
  return answer === "y" || answer === "yes";
};

const printInstalled = (context: LocalRunContext, result: InstallResult): void => {
  context.out(
    `${result.reused === true ? "already installed" : "installed"} ${result.installed.release.id} at ${result.installed.path}` +
      (result.selected ? " (selected)" : ""),
  );
  if (result.reused !== true) context.out(`source ${result.url}`);
};

const runInstall = async (
  context: LocalRunContext,
  tool: ManagedToolName,
  version: string,
  variant: ToolchainVariant,
  mirror: string | undefined,
): Promise<number> => {
  try {
    const result = await installManaged(tool, {
      version,
      variant,
      ...(mirror === undefined ? {} : { mirror }),
      ...(asBoolean(context.parsed, "force") === true ? { force: true } : {}),
    });
    if (asBoolean(context.parsed, "json") === true) {
      context.out(JSON.stringify({ state: "installed", ...result }, null, 2));
    } else {
      printInstalled(context, result);
    }
    return EXIT_OK;
  } catch (error) {
    if (error instanceof ManagedToolchainError) {
      context.out(`error: ${error.code}: ${error.message}`);
      return EXIT_NO;
    }
    throw error;
  }
};

const setup = async (context: LocalRunContext): Promise<number> => {
  const json = asBoolean(context.parsed, "json") === true;
  const yes = asBoolean(context.parsed, "yes") === true;
  const mirror = asString(context.parsed, "mirror");
  const interactive = !json && !yes && stdin.isTTY === true && stdout.isTTY === true;
  const libuvcppDefault =
    defaultRelease("libuvcpp") ??
    findRelease("libuvcpp", { version: LATEST_TOOLCHAIN_VERSION.libuvcpp });
  const cmakeDefault =
    defaultRelease("cmake") ?? findRelease("cmake", { version: LATEST_TOOLCHAIN_VERSION.cmake });
  if (libuvcppDefault === undefined || cmakeDefault === undefined) {
    context.out("error: no supported libuvcpp/CMake release exists for this platform");
    return EXIT_NO;
  }

  let libuvcppVersion = libuvcppDefault.version;
  let libuvcppVariant = libuvcppDefault.variant;
  let cmakeVersion = cmakeDefault.version;
  let cmakeVariant = cmakeDefault.variant;
  let proceed = true;

  let reader: ReturnType<typeof createInterface> | undefined;
  try {
    if (interactive) {
      reader = createInterface({ input: stdin, output: stdout });
      context.out(`uvp environment setup for ${process.platform}-${process.arch}`);
      context.out("Press Enter to accept the default, or type another value.");
      libuvcppVersion = await ask(reader, "libuvcpp version", libuvcppDefault.version);
      libuvcppVariant = (await ask(
        reader,
        "libuvcpp variant",
        libuvcppDefault.variant,
      )) as ToolchainVariant;
      cmakeVersion = await ask(reader, "CMake version", cmakeDefault.version);
      cmakeVariant = (await ask(reader, "CMake variant", cmakeDefault.variant)) as ToolchainVariant;
      proceed = await askYesNo(
        reader,
        `Install to ${(await managedStatus()).home} and select both`,
        true,
      );
    }

    if (!proceed) {
      context.out("nothing installed");
      return EXIT_OK;
    }

    // CMake first. It is the extractor for the libuvcpp zip on a host that has
    // neither `unzip` nor a system CMake, and the one-command path must not
    // depend on a tool the command is about to install.
    const cmake = await installManaged("cmake", {
      version: cmakeVersion,
      variant: cmakeVariant,
      ...(mirror === undefined ? {} : { mirror }),
      // Re-running the wizard is how a user repairs or re-selects a machine;
      // only an explicit `--force` replaces the bytes.
      ...(asBoolean(context.parsed, "force") === true ? { force: true } : {}),
      reuse: asBoolean(context.parsed, "force") !== true,
    });
    if (cmake.installed.executable !== undefined) {
      const bin = dirname(cmake.installed.executable);
      process.env["PATH"] = `${bin}${delimiter}${process.env["PATH"] ?? ""}`;
    }
    const libuvcpp = await installManaged("libuvcpp", {
      version: libuvcppVersion,
      variant: libuvcppVariant,
      ...(mirror === undefined ? {} : { mirror }),
      ...(asBoolean(context.parsed, "force") === true ? { force: true } : {}),
      reuse: asBoolean(context.parsed, "force") !== true,
    });
    if (json) {
      context.out(
        JSON.stringify(
          {
            state: "installed",
            host: { platform: process.platform, arch: process.arch },
            libuvcpp: {
              version: libuvcpp.installed.release.version,
              variant: libuvcpp.installed.release.variant,
              path: libuvcpp.installed.path,
              url: libuvcpp.url,
            },
            cmake: {
              version: cmake.installed.release.version,
              variant: cmake.installed.release.variant,
              path: cmake.installed.path,
              executable: cmake.installed.executable,
              url: cmake.url,
            },
            next: "uvp init ./my-service --name my-service --template hello-http",
          },
          null,
          2,
        ),
      );
      return EXIT_OK;
    }
    printInstalled(context, libuvcpp);
    printInstalled(context, cmake);
    context.out("");
    context.out("environment ready. Next:");
    context.out("  uvp init ./my-service --name my-service --template hello-http");
    context.out("  uvp build ./my-service");
    return EXIT_OK;
  } catch (error) {
    if (error instanceof ManagedToolchainError) {
      context.out(`error: ${error.code}: ${error.message}`);
      if (error.details.length > 0) context.out(`details: ${error.details.join("; ")}`);
      return EXIT_NO;
    }
    throw error;
  } finally {
    reader?.close();
  }
};

const parseTarget = (value: string | undefined): ReturnType<typeof parseToolchainReference> => {
  if (value === undefined) {
    throw new ManagedToolchainError(
      "unknown_release",
      "name a toolchain, for example libuvcpp@1.11.0 or cmake@3.31.6",
    );
  }
  try {
    return parseToolchainReference(value);
  } catch (error) {
    throw new ManagedToolchainError(
      "unknown_release",
      error instanceof Error ? error.message : String(error),
    );
  }
};

const command = async (context: LocalRunContext): Promise<number> => {
  const action = context.parsed.positionals[0] ?? "setup";
  const json = asBoolean(context.parsed, "json") === true;
  const versionFlag = asString(context.parsed, "version");
  const variantFlag = asString(context.parsed, "variant");
  const mirror = asString(context.parsed, "mirror");

  try {
    if (action === "setup") return await setup(context);

    if (action === "status") {
      const status = await managedStatus();
      if (json) {
        context.out(JSON.stringify(status, null, 2));
      } else {
        context.out(`home      ${status.home}`);
        context.out(`config    ${status.configPath}`);
        context.out(`host      ${status.platform}-${status.arch}`);
        for (const tool of ["libuvcpp", "cmake"] as const) {
          const selected = status.selected[tool];
          const installed = status.installed.filter((entry) => entry.release.tool === tool);
          context.out(
            `${tool.padEnd(9)} ${selected === undefined ? "not selected" : `${selected.version}:${selected.variant}`}` +
              `, ${installed.length} installed`,
          );
        }
      }
      return EXIT_OK;
    }

    if (action === "list") {
      const installed = await listInstalled();
      if (json) {
        context.out(JSON.stringify({ catalog: TOOLCHAIN_CATALOG, installed }, null, 2));
      } else {
        for (const tool of ["libuvcpp", "cmake"] as const) {
          context.out(`${tool}:`);
          for (const version of TOOLCHAIN_VERSIONS[tool]) {
            const variants = TOOLCHAIN_CATALOG.filter(
              (release) => release.tool === tool && release.version === version,
            ).map((release) => release.variant);
            const marks = variants.map((variant) =>
              installed.some(
                (entry) =>
                  entry.release.tool === tool &&
                  entry.release.version === version &&
                  entry.release.variant === variant,
              )
                ? `${variant}*`
                : variant,
            );
            context.out(`  ${version}  ${marks.join(", ")}`);
          }
        }
        context.out("`*` means installed in the managed root.");
      }
      return EXIT_OK;
    }

    if (action === "install") {
      const target = parseTarget(context.parsed.positionals[1]);
      const version = versionFlag ?? target.version ?? LATEST_TOOLCHAIN_VERSION[target.tool];
      const variant =
        (variantFlag as ToolchainVariant | undefined) ?? target.variant ?? hostVariant(target.tool);
      if (variant === undefined) {
        context.out(
          `error: no default variant for ${target.tool} on ${process.platform}-${process.arch}; pass --variant`,
        );
        return EXIT_NO;
      }
      return await runInstall(context, target.tool, version, variant, mirror);
    }

    if (action === "use") {
      const target = parseTarget(context.parsed.positionals[1]);
      const version = versionFlag ?? target.version;
      const variant =
        (variantFlag as ToolchainVariant | undefined) ?? target.variant ?? hostVariant(target.tool);
      if (version === undefined || variant === undefined) {
        context.out(
          "error: use needs a version, for example libuvcpp@1.11.0:linux-x64 or cmake@3.31.6",
        );
        return EXIT_NO;
      }
      await selectManaged(target.tool, { version, variant });
      context.out(`selected ${target.tool}@${version}:${variant}`);
      return EXIT_OK;
    }

    if (action === "remove") {
      const target = parseTarget(context.parsed.positionals[1]);
      const removed = await removeManaged(target.tool, {
        ...(target.version === undefined ? {} : { version: target.version }),
        ...(target.variant === undefined ? {} : { variant: target.variant }),
      });
      context.out(`removed ${removed}`);
      return EXIT_OK;
    }

    if (action === "mirror") {
      const target = parseTarget(context.parsed.positionals[1]);
      if (mirror === undefined) {
        context.out("error: mirror needs --mirror URL");
        return EXIT_NO;
      }
      await setMirror(target.tool, mirror);
      context.out(`mirror for ${target.tool}: ${mirror}`);
      return EXIT_OK;
    }

    context.out(
      `error: unknown env action '${action}'; use setup, status, list, install, use, remove, or mirror`,
    );
    return EXIT_NO;
  } catch (error) {
    if (error instanceof ManagedToolchainError) {
      context.out(`error: ${error.code}: ${error.message}`);
      return EXIT_NO;
    }
    throw error;
  }
};

export const envCommand: CommandSpec = {
  path: ["env"],
  summary: "Install and select the libuvcpp and CMake builds uvp uses.",
  usage:
    "uvp env [setup|status|list|install|use|remove|mirror] [TARGET] " +
    "[--version V] [--variant V] [--mirror URL] [--force] [--yes] [--json]",
  positionals: [
    {
      name: "ACTION",
      description: "setup (default), status, list, install, use, remove, or mirror.",
    },
    {
      name: "TARGET",
      description:
        "For install/use/remove: libuvcpp[@version][:variant] or cmake[@version][:variant].",
    },
  ],
  flags: [
    {
      name: "version",
      type: "string",
      value: "V",
      description: "A catalogued version. Defaults to the newest supported release.",
    },
    {
      name: "variant",
      type: "string",
      value: "V",
      description:
        "linux-x64, linux-arm64, mingw-x64, mingw-arm64, msvc-x64, msvc-arm64, windows-x64, windows-arm64, or macos-universal.",
    },
    {
      name: "mirror",
      type: "string",
      value: "URL",
      description:
        "Download base or template; may contain {version}, {variant}, and {asset}. Saved for future installs.",
    },
    {
      name: "force",
      type: "boolean",
      description: "Reinstall over an existing version.",
    },
    {
      name: "yes",
      alias: ["y"],
      type: "boolean",
      description: "Accept every setup default without prompting.",
    },
  ],
  notes: [
    "With no action, setup proposes the newest supported libuvcpp (1.11.0) and CMake (3.31.6)",
    "for this host. Press Enter through the questions to accept them.",
    "Downloads are verified against a SHA-256 pinned in uvp, and installs stay under",
    "~/.uvp/toolchains. uvp does not edit your shell profile and never replaces a system install.",
    "Windows defaults to the MinGW libuvcpp archive; pass --variant msvc-x64 for the MSVC one.",
    "macOS has no libuvcpp archive in the catalog; CMake is available there.",
  ],
  run: command,
};
