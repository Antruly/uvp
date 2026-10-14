import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import type { ToolContract } from "../../../src/contracts/toolContractTypes.js";
import { freePort } from "../../support/ports.js";

/**
 * The MCP server as a client sees it.
 *
 * `uvp mcp` is the surface an agent actually talks to, and the one no other lane
 * reaches. A real `<bin> mcp` over real stdio is where a packaging mistake — a
 * missing file, a path that only resolves in a checkout — finally shows up, and it
 * is the only place the *protocol* promises are visible. Five are load-bearing:
 *
 * - **stdout is protocol traffic and nothing else.** Not "mostly protocol": one
 *   log line on stdout is a corrupt JSON-RPC frame, and a client reports it as a
 *   parse error with no hint where the extra byte came from. So the frames are
 *   parsed rather than grepped, and a line that does not parse is a failure rather
 *   than noise to be skipped past.
 * - **the advertised surface is the catalog.** What `tools/list` returns is a
 *   rendering of `TOOL_CONTRACTS`: same names, same order, same titles,
 *   descriptions, schemas, and behaviour hints. A schema written a second time in
 *   the registrar is a schema that can disagree with the one the handler enforces.
 * - **a result carries the object twice, and the two agree.** `content` is what a
 *   client that ignores structured output renders; `structuredContent` is what a
 *   client that honours `outputSchema` validates. A summary in `content` would be
 *   a second, quieter answer.
 * - **a failure is marked as one.** `isError: true` and no structured output, so
 *   nothing downstream can mistake a failure for a result with missing fields.
 * - **the server says which server it is.** `serverInfo.name` is the registry name
 *   from `package.json`, which is deliberately not the npm name.
 *
 * The session is opened once for the file and every assertion reads the same
 * transcript, so the lane costs one child process rather than one per question.
 *
 * ### How a failure is worded here, and what this lane therefore does not assert
 *
 * A handler failure reaches a client as the error contract rendered as text:
 * `code: message`, then a `remedy:` line. It is not the CLI's `--json` error
 * object, so `retryable` and `details` are not in it — a model cannot branch on
 * retryability here the way a script branches on the CLI's exit code. Whether the
 * structured error should also travel in `structuredContent` is a decision about
 * the failure shape rather than a defect, so the assertions below pin the parts
 * that are promised and stay silent on the parts that are merely absent.
 *
 * A *schema violation* is answered by the SDK's own validator before uvp's handler
 * runs, so its text reads `Input validation error: …` and carries no uvp code. The
 * field is still named, which is what a caller needs in order to fix the call, and
 * the validator is the same schema object the handler parses with. Asserted below
 * as the property it is: the field is named.
 */

const promisified = promisify(execFile);

const REPOSITORY = resolve(import.meta.dirname, "..", "..", "..");
/** The published entry point — `bin.uvp` in package.json, what `npm i -g` links. */
const UVP = join(REPOSITORY, "scripts", "uvp.mjs");

/** A request that has not been answered in this long is not slow, it is hung. */
const TIMEOUT_MS = 20_000;

/** The revision this client speaks, as a client of this era would send it. */
const PROTOCOL_VERSION = "2025-06-18";

/**
 * What `package.json` declares, read as a file rather than imported.
 *
 * The server embeds these facts at build time — `src/generatedPackageMetadata.ts`
 * is generated from this manifest. Reading the manifest here is what makes the
 * comparison mean something: the published declaration on one side, and the
 * running process's own account of itself on the other.
 */
const manifest = JSON.parse(readFileSync(join(REPOSITORY, "package.json"), "utf8")) as {
  readonly name: string;
  readonly version: string;
  readonly mcpName: string;
};

/** `uvp doctor` exits 1 when it finds no libuvcpp, and that report is a result. */
const NO_LIBUVCPP_IS_AN_ANSWER =
  "a report that finds no libuvcpp is an answer of no, so it exits 1 rather than failing";

const CONTRACT_BY_NAME = new Map(TOOL_CONTRACTS.map((contract) => [contract.name, contract]));

const contractNamed = (name: string): ToolContract => {
  const contract = CONTRACT_BY_NAME.get(name);
  if (contract === undefined) throw new Error(`No tool contract is named ${name}.`);
  return contract;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface RpcError {
  readonly code: number;
  readonly message: string;
}

/**
 * One frame on the wire, in the parts this lane reads.
 *
 * Every field is present-and-possibly-undefined rather than optional, because the
 * frame is decoded from JSON and a field that was not in the line is a fact about
 * the line rather than an absent property.
 */
interface Frame {
  readonly jsonrpc: unknown;
  readonly id: number | null | undefined;
  readonly method: unknown;
  readonly result: Record<string, unknown> | undefined;
  readonly error: RpcError | undefined;
}

const rpcError = (value: unknown): RpcError | undefined => {
  if (!isRecord(value)) return undefined;
  const code = value["code"];
  const message = value["message"];
  if (typeof code !== "number" || typeof message !== "string") return undefined;
  return { code, message };
};

/** A frame from one stdout line, or a failure naming the line that was not one. */
const asFrame = (line: string): Frame => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(
      `stdout carried a line that is not a JSON-RPC frame, so it is not protocol traffic: ${JSON.stringify(line)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`a JSON-RPC frame must be an object, not ${JSON.stringify(parsed)}`);
  }
  const id = parsed["id"];
  return {
    jsonrpc: parsed["jsonrpc"],
    id: typeof id === "number" || id === null ? id : undefined,
    method: parsed["method"],
    result: isRecord(parsed["result"]) ? parsed["result"] : undefined,
    error: rpcError(parsed["error"]),
  };
};

interface Exchange {
  readonly id: number;
  readonly method: string;
  /** What this request is here to ask, in the words of the contract. */
  readonly why: string;
}

interface CloseReport {
  readonly exit: number;
  readonly frames: readonly Frame[];
  readonly unparseable: readonly string[];
  readonly stderr: string;
}

interface Session {
  request(why: string, method: string, params?: unknown): Promise<Frame>;
  notify(method: string, params?: unknown): void;
  readonly sentIds: readonly number[];
  close(): Promise<CloseReport>;
}

/** The child, so `afterAll` can kill it if the session never got that far. */
let liveChild: ChildProcessWithoutNullStreams | undefined;

/**
 * A JSON-RPC client over the server's stdio, hand-rolled.
 *
 * The SDK's client package is not a dependency of this repository, and the lane
 * that proves the stream shape should not also be the lane that proves an
 * unrelated package installs. What a client needs is small: correlate by id,
 * answer nothing, and notice a line that is not a frame.
 */
const openSession = (): Session => {
  const child = spawn(process.execPath, [UVP, "mcp"], {
    cwd: REPOSITORY,
    stdio: ["pipe", "pipe", "pipe"],
  });
  liveChild = child;

  const sent: Exchange[] = [];
  const frames: Frame[] = [];
  const unparseable: string[] = [];
  const waiting = new Map<
    number,
    { resolve: (frame: Frame) => void; reject: (cause: Error) => void }
  >();
  let diagnostic = "";
  let remainder = "";
  let nextId = 1;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    diagnostic += chunk;
  });

  const receive = (line: string): void => {
    let frame: Frame;
    try {
      frame = asFrame(line);
    } catch (cause) {
      unparseable.push(line);
      // A client cannot recover from a corrupt stream and neither can this lane:
      // the pending request would otherwise sit until its own timeout and report
      // a hang where the real problem is the byte that did not belong.
      for (const { reject } of waiting.values()) reject(cause as Error);
      waiting.clear();
      return;
    }
    frames.push(frame);
    if (typeof frame.id !== "number") return;
    const settle = waiting.get(frame.id);
    if (settle === undefined) return;
    waiting.delete(frame.id);
    settle.resolve(frame);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    remainder += chunk;
    let index = remainder.indexOf("\n");
    while (index !== -1) {
      const line = remainder.slice(0, index);
      remainder = remainder.slice(index + 1);
      if (line.trim() !== "") receive(line);
      index = remainder.indexOf("\n");
    }
  });

  return {
    request: async (why, method, params) => {
      const id = nextId++;
      const answer = new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(
            new Error(
              `${method} was not answered within ${String(TIMEOUT_MS)}ms. stderr so far:\n${diagnostic}`,
            ),
          );
        }, TIMEOUT_MS);
        waiting.set(id, {
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
          reject: (cause) => {
            clearTimeout(timer);
            reject(cause);
          },
        });
      });
      const request = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
      child.stdin.write(`${JSON.stringify(request)}\n`);
      const response = await answer;
      sent.push({ id, method, why });
      return response;
    },
    notify: (method, params) => {
      const notification = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
      child.stdin.write(`${JSON.stringify(notification)}\n`);
    },
    get sentIds() {
      return sent.map((exchange) => exchange.id);
    },
    close: async () => {
      const exited = new Promise<number>((resolve) => {
        if (child.exitCode !== null) resolve(child.exitCode);
        else child.once("exit", (code) => resolve(code ?? -1));
      });
      // Closing the input is how a client says goodbye, and the server is
      // expected to end rather than linger until it is killed.
      child.stdin.end();
      const deadline = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
      const exit = await exited;
      clearTimeout(deadline);
      if (remainder.trim() !== "") receive(remainder);
      return { exit, frames, unparseable, stderr: diagnostic };
    },
  };
};

/** The result of a request, or a failure naming the JSON-RPC error instead. */
const resultOf = (frame: Frame, what: string): Record<string, unknown> => {
  if (frame.error !== undefined) {
    throw new Error(
      `${what} returned a JSON-RPC error ${String(frame.error.code)}: ${frame.error.message}`,
    );
  }
  if (frame.result === undefined) {
    throw new Error(`${what} carried neither a result nor an error: ${JSON.stringify(frame)}`);
  }
  return frame.result;
};

/** The parts of a tool result a client can act on. */
interface ToolResult {
  /** Was this call a failure — the only success flag the protocol has. */
  readonly isError: boolean;
  readonly text: string;
  readonly structured: Record<string, unknown> | undefined;
  readonly blocks: number;
}

const toolResultOf = (frame: Frame, what: string): ToolResult => {
  const result = resultOf(frame, what);
  const content = result["content"];
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`${what} returned no content blocks: ${JSON.stringify(result)}`);
  }
  const first: unknown = content[0];
  if (!isRecord(first) || first["type"] !== "text" || typeof first["text"] !== "string") {
    throw new Error(`${what}'s first content block is not text: ${JSON.stringify(first)}`);
  }
  return {
    isError: result["isError"] === true,
    text: first["text"],
    structured: isRecord(result["structuredContent"]) ? result["structuredContent"] : undefined,
    blocks: content.length,
  };
};

/** The fields a contract declares, read off its Zod object schema. */
const declaredFields = (contract: ToolContract): readonly string[] => {
  // Every contract in the catalog is an object schema — that is what lets the MCP
  // SDK convert it to JSON Schema *and* lets the handler parse input with the same
  // value. `TOOL_CONTRACTS` is deliberately polymorphic, so the shape has to be
  // reached through a cast; a contract that is not an object schema is named as
  // such rather than failing later as an undefined property.
  const shape = (contract.inputSchema as { readonly shape?: Record<string, unknown> }).shape;
  if (shape === undefined) {
    throw new Error(`${contract.name}'s input schema is not an object schema.`);
  }
  return Object.keys(shape).sort();
};

/** The fields a served tool advertises, from either of its two schemas. */
const advertisedFields = (schema: unknown): readonly string[] => {
  if (!isRecord(schema)) return [];
  const properties = schema["properties"];
  return isRecord(properties) ? Object.keys(properties).sort() : [];
};

/** A failing assertion that prints the schema issues, which `toBe(false)` will not. */
const expectValidAgainstContract = (
  contract: ToolContract,
  output: Record<string, unknown>,
): void => {
  const validated = contract.outputSchema.safeParse(output);
  if (!validated.success) {
    throw new Error(
      `the served result does not satisfy the outputSchema the server advertises for ${contract.name}:\n${JSON.stringify(validated.error.issues, null, 2)}`,
    );
  }
};

/** The first evidence entry, which is where the identity of a result lives. */
const evidenceOf = (result: ToolResult): Record<string, unknown> => {
  const evidence = result.structured?.["evidence"];
  const first: unknown = Array.isArray(evidence) ? evidence[0] : undefined;
  if (!isRecord(first)) {
    throw new Error(
      `the result carried no evidence to compare: ${JSON.stringify(result.structured)}`,
    );
  }
  return first;
};

/**
 * The same value with the deliberately unstable parts removed.
 *
 * `evidence_id` and `unknown_id` are random by contract, and `observed_at` is a
 * clock reading, so two runs of the same question differ in exactly those and
 * nothing else. Every other field — the content digest included, which digests the
 * content rather than the envelope — must agree, and is compared.
 */
const withoutIdentity = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutIdentity);
  if (!isRecord(value)) return value;
  const stable: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key.endsWith("_id") || key === "observed_at") continue;
    stable[key] = withoutIdentity(inner);
  }
  return stable;
};

interface Observations {
  readonly initialize: Frame;
  readonly list: Frame;
  readonly success: ToolResult;
  readonly stillAnswering: ToolResult;
  readonly badArguments: ToolResult;
  readonly unreachable: ToolResult;
  readonly unknownTool: Frame;
  readonly unknownMethod: Frame;
  readonly close: CloseReport;
  readonly sentIds: readonly number[];
}

let observations: Observations;

const listedTools = (): readonly Record<string, unknown>[] => {
  const listed = resultOf(observations.list, "tools/list")["tools"];
  if (!Array.isArray(listed)) {
    throw new Error(`tools/list returned no array: ${JSON.stringify(listed)}`);
  }
  return listed as Record<string, unknown>[];
};

beforeAll(async () => {
  const session = openSession();
  const initialize = await session.request("the handshake", "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "uvp-mcp-boundary", version: "0.0.0" },
  });
  session.notify("notifications/initialized");
  const list = await session.request("the advertised surface", "tools/list", {});
  const success = toolResultOf(
    await session.request("a tool that answers", "tools/call", {
      name: "uvp_doctor",
      arguments: {},
    }),
    "uvp_doctor",
  );
  // A schema violation, answered by the SDK's validator before uvp's handler runs.
  const badArguments = toolResultOf(
    await session.request("arguments the contract rejects", "tools/call", {
      name: "uvp_http_request",
      arguments: {},
    }),
    "uvp_http_request with no url",
  );
  // A real failure from inside the handler: nothing is listening on that port.
  const closedPort = await freePort();
  const unreachable = toolResultOf(
    await session.request("an endpoint that is not there", "tools/call", {
      name: "uvp_http_request",
      arguments: { url: `http://127.0.0.1:${String(closedPort)}/` },
    }),
    "uvp_http_request against a closed port",
  );
  const unknownTool = await session.request("a tool that does not exist", "tools/call", {
    name: "uvp_nope",
    arguments: {},
  });
  const unknownMethod = await session.request("a method that does not exist", "nope/nope", {});
  const stillAnswering = toolResultOf(
    await session.request("the same question again, after three failures", "tools/call", {
      name: "uvp_doctor",
      arguments: {},
    }),
    "uvp_doctor, second call",
  );

  const sentIds = session.sentIds;
  observations = {
    initialize,
    list,
    success,
    stillAnswering,
    badArguments,
    unreachable,
    unknownTool,
    unknownMethod,
    close: await session.close(),
    sentIds,
  };
}, TIMEOUT_MS * 3);

afterAll(() => {
  // The session closed in `beforeAll`; this is the net under the case where it did
  // not, because a lane that leaves an MCP server running is a lane nobody can run
  // twice.
  if (liveChild !== undefined && liveChild.exitCode === null && liveChild.signalCode === null) {
    liveChild.kill("SIGKILL");
  }
});

describe("the stream carries protocol traffic and nothing else", () => {
  it("has no line on stdout that is not a JSON-RPC frame", () => {
    // The packaged tarball check's rule, restated where it can see the whole
    // session: a banner, a progress line, or a warning sent to the wrong stream is
    // a corrupt frame, not noise to be skipped past.
    expect(observations.close.unparseable, "stdout must carry nothing but JSON-RPC frames").toEqual(
      [],
    );
    expect(observations.close.frames.length).toBeGreaterThan(0);
    for (const frame of observations.close.frames) {
      expect(frame.jsonrpc).toBe("2.0");
    }
  });

  it("answers every request exactly once, and answers nothing that was not asked", () => {
    // One frame per request id, and no frame bearing an id nobody sent. This is
    // also the assertion that a *notification* went unanswered: a reply to one
    // carries no id, so it would arrive as a frame with no request behind it.
    const answered = observations.close.frames
      .map((frame) => frame.id)
      .filter((id): id is number => typeof id === "number")
      .sort((left, right) => left - right);
    expect(answered).toEqual([...observations.sentIds].sort((left, right) => left - right));
    expect(observations.close.frames).toHaveLength(observations.sentIds.length);
  });

  it("ends when its input closes", () => {
    // A server that lingers after its client says goodbye is one every launcher has
    // to kill, and a client configuration entry that never exits.
    expect(observations.close.exit, `stderr:\n${observations.close.stderr}`).toBe(0);
  });
});

describe("the server says which server it is", () => {
  it("advertises the registry name from package.json, which is not the npm name", () => {
    const result = resultOf(observations.initialize, "initialize");
    const info = result["serverInfo"];
    if (!isRecord(info))
      throw new Error(`initialize returned no serverInfo: ${JSON.stringify(info)}`);
    expect(info["name"]).toBe(manifest.mcpName);
    expect(info["name"]).not.toBe(manifest.name);
    expect(info["version"]).toBe(manifest.version);
    expect(typeof info["title"]).toBe("string");
  });

  it("negotiates the protocol revision this client asked for", () => {
    // A server that could not speak the requested revision answers with one it can,
    // and the client then decides whether to continue. Equal versions mean the
    // handshake completed without a downgrade.
    expect(resultOf(observations.initialize, "initialize")["protocolVersion"]).toBe(
      PROTOCOL_VERSION,
    );
  });

  it("tells the model where to start and what to read", () => {
    // The instructions are the one thing a tool description cannot say: the order
    // the tools are meant to be used in, and the two fields on every result that
    // change what a caller does next.
    const instructions = resultOf(observations.initialize, "initialize")["instructions"];
    expect(typeof instructions).toBe("string");
    expect(String(instructions)).toContain("uvp_doctor");
    expect(String(instructions)).toContain("unknowns");
  });
});

describe("the advertised surface is the catalog", () => {
  it("lists exactly the contracted tools, in catalog order", () => {
    const names = listedTools().map((tool) => tool["name"]);
    expect(names).toEqual(TOOL_CONTRACTS.map((contract) => contract.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it("takes each tool's title, description, and behaviour hints from its contract", () => {
    // The registrar copies these rather than writing them again; a description
    // edited in the server would be a description that appears nowhere else, and
    // the catalog published at /uvp/tool-catalog.json would disagree with the
    // surface a client sees.
    for (const tool of listedTools()) {
      const contract = contractNamed(String(tool["name"]));
      expect(tool["title"], contract.name).toBe(contract.title);
      expect(tool["description"], contract.name).toBe(contract.description);
      expect(tool["annotations"], contract.name).toEqual(contract.annotations);
    }
  });

  it("advertises the schema the handler parses with", () => {
    // Two renderings of one value: the SDK converts the contract's Zod schema for
    // `tools/list`, and the handler parses the incoming arguments with the same
    // schema. A field advertised and not enforced, or enforced and not advertised,
    // shows up here as a difference in the field names.
    for (const tool of listedTools()) {
      const contract = contractNamed(String(tool["name"]));
      // An empty pair of lists would compare equal and say nothing, so a contract
      // with no declared fields is a failure of this file rather than a pass.
      expect(declaredFields(contract).length, contract.name).toBeGreaterThan(0);
      expect(advertisedFields(tool["inputSchema"]), contract.name).toEqual(
        declaredFields(contract),
      );
    }
  });

  it("carries the two fields the instructions tell a model to read in every output schema", () => {
    for (const tool of listedTools()) {
      const fields = advertisedFields(tool["outputSchema"]);
      expect(fields, String(tool["name"])).toContain("unknowns");
      expect(fields, String(tool["name"])).toContain("limitations");
    }
  });
});

describe("a result carries the object twice, and the two agree", () => {
  it("renders the complete object as text beside the structured output", () => {
    // `content` is for a client that ignores structured output, and it is the whole
    // answer: a summary here would be a second, quieter answer, and an agent
    // reading only this block would never learn which fields it was missing.
    expect(observations.success.isError).toBe(false);
    expect(observations.success.blocks).toBe(1);
    expect(observations.success.structured).toBeDefined();
    expect(observations.success.text).toBe(
      JSON.stringify(observations.success.structured, null, 2),
    );
  });

  it("parses back to the same object, not to a rendering of it", () => {
    expect(JSON.parse(observations.success.text)).toEqual(observations.success.structured);
  });

  it("satisfies the output schema the same tool advertises", () => {
    // A client that honours `outputSchema` validates this result, so a server whose
    // own answer fails its own advertised schema is a server that client rejects.
    const structured = observations.success.structured;
    if (structured === undefined)
      throw new Error("the success result carried no structured content.");
    const contract = contractNamed("uvp_doctor");
    expectValidAgainstContract(contract, structured);
    expect(structured["tool"]).toBe("uvp_doctor");
    // The negative control. A schema that accepted anything would make the
    // assertion above hold for a result the client should have rejected.
    expect(contract.outputSchema.safeParse({ tool: "uvp_doctor" }).success).toBe(false);
  });
});

describe("a failure is a failure, on both paths", () => {
  it("marks a handler failure as an error and carries no structured output", () => {
    // `isError` results skip output-schema validation, which is what makes this
    // path usable: a failure has no envelope, because it never produced one. A
    // `structuredContent` here would be a result-shaped object for a call that
    // returned no result.
    expect(observations.unreachable.isError).toBe(true);
    expect(observations.unreachable.structured).toBeUndefined();
  });

  it("renders the error contract as text: the code, then the remedy", () => {
    expect(observations.unreachable.text).toMatch(/^endpoint_unreachable: /u);
    expect(observations.unreachable.text).toContain("\nremedy: ");
  });

  it("does not let a failure arrive shaped like a result", () => {
    // The MCP form of the CLI's rule that a failure never reaches stdout: what a
    // client parses for `tool` and `unknowns` must not be handed to it for a call
    // that failed.
    expect(observations.unreachable.text.startsWith("{")).toBe(false);
  });

  it("names the offending field when the contract rejects the arguments", () => {
    // The SDK's validator answers before uvp's handler, so this text is not the uvp
    // error contract and carries no uvp code — see the header. What a caller needs
    // in order to fix the call is the field, and it is there.
    expect(observations.badArguments.isError).toBe(true);
    expect(observations.badArguments.structured).toBeUndefined();
    expect(observations.badArguments.text).toContain("url");
  });

  it("refuses a tool name that does not exist as a protocol error, not as a result", () => {
    expect(observations.unknownTool.error?.code).toBe(-32602);
    expect(observations.unknownTool.result).toBeUndefined();
    expect(observations.unknownTool.error?.message).toContain("uvp_nope");
  });

  it("refuses an unknown method as a protocol error", () => {
    expect(observations.unknownMethod.error?.code).toBe(-32601);
    expect(observations.unknownMethod.result).toBeUndefined();
  });
});

describe("the server keeps answering", () => {
  it("answers the same question after three failures", () => {
    // A server that died on the first rejected call would have satisfied every
    // assertion above about that call.
    expect(observations.stillAnswering.isError).toBe(false);
    expect(observations.stillAnswering.structured?.["tool"]).toBe("uvp_doctor");
    expect(observations.close.exit).toBe(0);
  });

  it("gives the same content a different identity", () => {
    // Both calls ask the same question of the same host, so the evidence digest —
    // a digest of the content — is the same, while the evidence id, which is random
    // by contract, is not. A caller that keyed on either one would be treating two
    // different things as one.
    const first = evidenceOf(observations.success);
    const second = evidenceOf(observations.stillAnswering);
    expect(second["digest"]).toBe(first["digest"]);
    expect(second["evidence_id"]).not.toBe(first["evidence_id"]);
  });
});

describe("both front ends answer the same question the same way", () => {
  it("returns the CLI's --json result for the same tool", async () => {
    // The claim both adapters are built on: one dispatch table behind them, so a
    // difference between the two is a bug in one of the front ends rather than a
    // difference in what they were asked. `uvp_doctor` is the tool both can run
    // without a workspace, and its answer is a fact about this host.
    //
    // A non-zero exit is not a failure here: `doctor` exits 1 when it finds no
    // libuvcpp. What must hold is that stdout carries the result, which is the
    // promise the CLI lane checks from the other side.
    const run = await promisified(process.execPath, [UVP, "doctor", "--json"], {
      cwd: REPOSITORY,
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    }).then(
      ({ stdout }) => ({ stdout, exit: 0 }),
      (cause: { readonly code?: unknown; readonly stdout?: string; readonly message: string }) => {
        if (typeof cause.code !== "number")
          throw new Error(`uvp doctor did not exit: ${cause.message}`);
        return { stdout: cause.stdout ?? "", exit: cause.code };
      },
    );
    expect(run.exit, NO_LIBUVCPP_IS_AN_ANSWER).toBeLessThan(2);
    const cliResult: unknown = JSON.parse(run.stdout);
    if (!isRecord(cliResult)) {
      throw new Error(`uvp doctor --json printed no object: ${run.stdout.slice(0, 200)}`);
    }
    expect(withoutIdentity(cliResult)).toEqual(withoutIdentity(observations.success.structured));
  });
});
