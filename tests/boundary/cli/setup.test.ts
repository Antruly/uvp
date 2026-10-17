import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { EXIT_OK, EXIT_WRONG } from "../../../src/cli/exitCodes.js";
import { parseUvpError } from "../../../src/domain/errors.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../../src/generatedPackageMetadata.js";

/**
 * `uvp setup --write` as a process, against files it did not create.
 *
 * The setup command is the first thing a new user runs and the only command that
 * writes into a file someone else owns, so its promises are about bytes on disk
 * rather than about a result object:
 *
 * - **printing is a configuration and nothing else.** stdout is one JSON object,
 *   which is what `uvp setup | jq .` and a reader both need.
 * - **writing merges.** Every server the file already listed survives, every
 *   top-level key survives, and only uvp's own entry is replaced. A setup that
 *   dropped the other servers would delete someone's work in the name of adding
 *   one line to it.
 * - **a file uvp cannot read is left alone.** A config it cannot parse is
 *   likelier to be mid-edit than corrupt, so the command refuses — exit 2, the
 *   bytes unchanged — rather than deciding for its author.
 *
 * The last of those is the one worth a process test rather than a unit one: the
 * failure has to happen *before* the write, and "the file still has its original
 * bytes" is a claim about the filesystem, not about a return value.
 *
 * What this file deliberately does not claim is a backup. The current write is a
 * whole-file rewrite that keeps everything it does not own, and it leaves no
 * copy of the previous bytes; the clean-environment acceptance records that as
 * observed rather than promising it here.
 */

const promisified = promisify(execFile);

const REPOSITORY = resolve(import.meta.dirname, "..", "..", "..");
/** The published entry point — `bin.uvp` in package.json, what `npm i -g` links. */
const UVP = join(REPOSITORY, "scripts", "uvp.mjs");

/** A process that has not answered in this long is not slow, it is hung. */
const TIMEOUT_MS = 20_000;

interface Observation {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run `uvp` with `cwd`, which is what the default target is resolved against. */
const invoke = async (cwd: string, args: readonly string[]): Promise<Observation> => {
  try {
    const { stdout, stderr } = await promisified(process.execPath, [UVP, ...args], {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { exit: EXIT_OK, stdout, stderr };
  } catch (cause) {
    const failure = cause as { code?: unknown; stdout?: string; stderr?: string; message: string };
    if (typeof failure.code !== "number") {
      throw new Error(`uvp ${args.join(" ")} did not exit: ${failure.message}`);
    }
    return { exit: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

/** The single JSON object stdout promised, or a failure naming what was there. */
const soleJson = (text: string, where: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${where} is not one JSON value: ${JSON.stringify(text.slice(0, 200))}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${where} is JSON but not an object: ${JSON.stringify(text.slice(0, 200))}`);
  }
  return parsed as Record<string, unknown>;
};

const SCRATCH = realpathSync(tmpdir());
const root = join(SCRATCH, `uvp-setup-boundary-${String(process.pid)}`);

/** A fresh directory per case, so nothing one case writes is visible to another. */
const caseDirectory = (name: string): string => {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  return directory;
};

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("uvp setup prints a configuration", () => {
  it("prints exactly one JSON object for the default client, pinned to this build", async () => {
    const observation = await invoke(SCRATCH, ["setup"]);
    expect(observation.exit).toBe(EXIT_OK);
    expect(observation.stderr).toBe("");
    const config = soleJson(observation.stdout, "uvp setup stdout");
    const servers = config["mcpServers"] as Record<string, Record<string, unknown>>;
    const entry = servers["io.github.Antruly/uvp"];
    expect(entry).toEqual({
      command: "npx",
      // The version is pinned rather than floating: the tool set is the
      // interface, and an unpinned `npx` would upgrade it under a config
      // written months earlier.
      args: ["-y", `${PACKAGE_NAME}@${PACKAGE_VERSION}`, "mcp"],
      type: "stdio",
    });
  });

  it("omits the stdio type for cursor, which does not take one", async () => {
    const observation = await invoke(SCRATCH, ["setup", "--client", "cursor"]);
    expect(observation.exit).toBe(EXIT_OK);
    const config = soleJson(observation.stdout, "uvp setup --client cursor stdout");
    const servers = config["mcpServers"] as Record<string, Record<string, unknown>>;
    expect(servers["io.github.Antruly/uvp"]).toEqual({
      command: "npx",
      args: ["-y", `${PACKAGE_NAME}@${PACKAGE_VERSION}`, "mcp"],
    });
  });

  it("refuses a client it does not know, without printing a configuration", async () => {
    const observation = await invoke(SCRATCH, ["setup", "--client", "no-such-client", "--json"]);
    expect(observation.exit).toBe(EXIT_WRONG);
    expect(observation.stdout).toBe("");
    const failure = parseUvpError(soleJson(observation.stderr, "setup stderr"));
    expect(failure?.code).toBe("invalid_request");
    expect(failure?.message).toContain("no-such-client");
    expect(failure?.details?.["known"]).toEqual(["claude-code", "claude-desktop", "cursor"]);
  });
});

describe("uvp setup --write merges into a configuration it did not create", () => {
  it("creates the default target in the working directory", async () => {
    const directory = caseDirectory("default-target");
    const observation = await invoke(directory, ["setup", "--write"]);
    expect(observation.exit).toBe(EXIT_OK);
    const target = join(directory, ".mcp.json");
    expect(observation.stdout).toContain(`wrote ${target}`);
    expect(observation.stdout).toContain(`client claude-code`);
    const written = soleJson(readFileSync(target, "utf8"), target);
    expect(Object.keys(written)).toEqual(["mcpServers"]);
  });

  it("keeps every other server and top-level key, and replaces only uvp's entry", async () => {
    const directory = caseDirectory("merge");
    const target = join(directory, "mcp.json");
    writeFileSync(
      target,
      `${JSON.stringify(
        {
          theme: "dark",
          mcpServers: {
            "other-server": { command: "other", args: ["serve"] },
            "io.github.Antruly/uvp": { command: "stale", args: [] },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const observation = await invoke(directory, ["setup", "--write", "--path", target, "--json"]);
    expect(observation.exit).toBe(EXIT_OK);

    const written = soleJson(readFileSync(target, "utf8"), target);
    expect(written["theme"]).toBe("dark");
    const servers = written["mcpServers"] as Record<string, Record<string, unknown>>;
    expect(servers["other-server"]).toEqual({ command: "other", args: ["serve"] });
    expect(servers["io.github.Antruly/uvp"]).toEqual({
      command: "npx",
      args: ["-y", `${PACKAGE_NAME}@${PACKAGE_VERSION}`, "mcp"],
      type: "stdio",
    });
    // A whole-file rewrite, so the file's own formatting is normalised; what is
    // promised is the content, not the byte layout of the previous author.
    expect(readFileSync(target, "utf8").endsWith("\n")).toBe(true);
  });

  it("writes the file it names and no other, which is the whole of its backup story", async () => {
    // Observed rather than required: the write leaves no copy of the previous
    // bytes beside the target. `uvp setup --write` therefore protects the parts
    // of a config it does not own by keeping them, not by keeping a backup of
    // the file. The clean-environment acceptance records this as a finding, so a
    // later decision to write a `.bak` shows up as an intentional change here.
    const directory = caseDirectory("only-target");
    const target = join(directory, "mcp.json");
    writeFileSync(target, `${JSON.stringify({ mcpServers: {} })}\n`, "utf8");

    const observation = await invoke(directory, ["setup", "--write", "--path", target, "--json"]);
    expect(observation.exit).toBe(EXIT_OK);
    expect(readdirSync(directory)).toEqual(["mcp.json"]);
  });

  it("treats an empty file as a configuration with nothing in it", async () => {
    const directory = caseDirectory("empty");
    const target = join(directory, "mcp.json");
    writeFileSync(target, "", "utf8");

    const observation = await invoke(directory, ["setup", "--write", "--path", target, "--json"]);
    expect(observation.exit).toBe(EXIT_OK);
    const written = soleJson(readFileSync(target, "utf8"), target);
    expect(Object.keys(written)).toEqual(["mcpServers"]);
  });
});

describe("uvp setup --write refuses a file it could not read", () => {
  it("leaves unparseable JSON exactly as it was, and names the file", async () => {
    const directory = caseDirectory("unparseable");
    const target = join(directory, "mcp.json");
    // Deliberately the shape of someone's half-finished edit, not of a file a
    // program produced: a comma with nothing after it.
    const original = '{ "mcpServers": { "other": { "command": "x" }, } }\n';
    writeFileSync(target, original, "utf8");

    const observation = await invoke(directory, ["setup", "--write", "--path", target, "--json"]);
    expect(observation.exit).toBe(EXIT_WRONG);
    expect(observation.stdout).toBe("");
    // The claim is about bytes, so it is made as bytes.
    expect(readFileSync(target, "utf8")).toBe(original);
    const failure = parseUvpError(soleJson(observation.stderr, "setup stderr"));
    expect(failure?.code).toBe("invalid_request");
    expect(failure?.message).toContain(target);
    expect(failure?.message).toContain("left it unchanged");
    expect(failure?.details?.["reason"]).toEqual(expect.any(String));
  });

  it("refuses a JSON value that is not an object, and leaves it alone", async () => {
    const directory = caseDirectory("array");
    const target = join(directory, "mcp.json");
    writeFileSync(target, "[]\n", "utf8");

    const observation = await invoke(directory, ["setup", "--write", "--path", target, "--json"]);
    expect(observation.exit).toBe(EXIT_WRONG);
    expect(readFileSync(target, "utf8")).toBe("[]\n");
    const failure = parseUvpError(soleJson(observation.stderr, "setup stderr"));
    expect(failure?.code).toBe("invalid_request");
    expect(failure?.message).toContain("not a JSON object");
  });

  it("refuses an mcpServers entry of the wrong shape instead of replacing it", async () => {
    const directory = caseDirectory("bad-servers");
    const target = join(directory, "mcp.json");
    const original = `${JSON.stringify({ mcpServers: ["not", "an", "object"] })}\n`;
    writeFileSync(target, original, "utf8");

    const observation = await invoke(directory, ["setup", "--write", "--path", target, "--json"]);
    expect(observation.exit).toBe(EXIT_WRONG);
    expect(readFileSync(target, "utf8")).toBe(original);
    expect(parseUvpError(soleJson(observation.stderr, "setup stderr"))?.message).toContain(
      "mcpServers",
    );
  });
});
