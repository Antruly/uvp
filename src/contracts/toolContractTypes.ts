import type { z } from "zod";

/**
 * A tool contract is the single source of truth for one capability.
 *
 * The CLI adapter and the MCP adapter both read these; neither owns them. That
 * is what keeps `uvp build` and the `uvp_build` tool from drifting apart, and
 * what lets the catalog, the docs page, and the shipped skill be generated
 * rather than hand-maintained.
 */
export const TOOL_KINDS = [
  "toolchain",
  "workspace",
  "build",
  "runtime",
  "web",
  "workflow",
] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/**
 * The external effects a tool may have, declared truthfully.
 *
 * `spawnsProcess` and `network` are separate because they carry different
 * risks: a tool that starts a compiler is not the same as one that opens a
 * socket to a host the user named. Callers gate on these.
 */
export interface ToolEffects {
  readonly readsFilesystem: boolean;
  readonly writesFilesystem: boolean;
  readonly network: boolean;
  readonly spawnsProcess: boolean;
  /** Can this change state outside the uvp workspace? */
  readonly mutatesTarget: boolean;
}

export const NO_EFFECTS: ToolEffects = {
  readsFilesystem: false,
  writesFilesystem: false,
  network: false,
  spawnsProcess: false,
  mutatesTarget: false,
};

/**
 * MCP behaviour hints. These are hints to the client, not enforcement; the
 * enforcement lives in the effect declaration above.
 */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolExample {
  readonly description: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * A contract, parameterised by its two schemas.
 *
 * The parameters are what let a handler be typed from its own contract —
 * `z.infer<typeof doctorContract.inputSchema>` is the real parse result, not
 * `unknown`. `TOOL_CONTRACTS` still holds plain `ToolContract`s, because the
 * catalog and the CLI adapter need to be polymorphic over all of them.
 */
export interface ToolContract<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: Input;
  readonly outputSchema: Output;
  readonly effects: ToolEffects;
  readonly annotations: ToolAnnotations;
  /**
   * True when the tool can return bytes that did not originate with uvp — a
   * response body, a captured frame, a compiler's own diagnostic text. Clients
   * mark these results as untrusted content, because a remote server's body is
   * data, never an instruction.
   */
  readonly returnsTargetContent: boolean;
  readonly examples: readonly ToolExample[];
}

export interface DefineToolInit<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: Input;
  readonly outputSchema: Output;
  readonly effects: ToolEffects;
  readonly annotations?: Partial<ToolAnnotations>;
  readonly returnsTargetContent?: boolean;
  readonly examples?: readonly ToolExample[];
}

/** Conventions for tool naming: snake_case, `uvp_` prefix, verb_noun. */
export const TOOL_NAME_PATTERN = /^uvp_[a-z][a-z0-9]*(_[a-z0-9]+)*$/u;

export const defineTool = <Input extends z.ZodType, Output extends z.ZodType>(
  init: DefineToolInit<Input, Output>,
): ToolContract<Input, Output> => {
  if (!TOOL_NAME_PATTERN.test(init.name)) {
    throw new Error(`Tool name "${init.name}" does not match ${TOOL_NAME_PATTERN.source}`);
  }
  return {
    name: init.name,
    title: init.title,
    description: init.description,
    kind: init.kind,
    inputSchema: init.inputSchema,
    outputSchema: init.outputSchema,
    effects: init.effects,
    annotations: {
      readOnlyHint: !init.effects.writesFilesystem && !init.effects.mutatesTarget,
      destructiveHint: init.effects.mutatesTarget,
      idempotentHint: !init.effects.writesFilesystem,
      openWorldHint: init.effects.network,
      ...init.annotations,
    },
    returnsTargetContent: init.returnsTargetContent ?? false,
    examples: init.examples ?? [],
  };
};

/** Tokens in a tool description that suggest undisclosed behaviour. */
export const EFFECT_WORDS = {
  writesFilesystem: ["write", "create", "scaffold", "generate", "save", "delete", "remove"],
  network: ["request", "connect", "fetch", "send", "call", "probe", "listen", "proxy"],
  spawnsProcess: ["build", "compile", "run", "launch", "execute", "start"],
} as const;
