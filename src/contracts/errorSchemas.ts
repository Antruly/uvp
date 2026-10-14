import { z } from "zod";

import { uvpErrorSchema } from "../domain/errors.js";

/**
 * How a failure reaches a caller.
 *
 * Output schemas describe the success shape only. A failure is a different
 * shape, and the difference is load-bearing: a result always carries
 * `isError: true` and never carries structured success content, so a caller
 * cannot mistake a partial failure payload for an answer. Everything a caller
 * needs to react — whether to retry, why it failed, what to do next — is in
 * `structuredContent.error`, and the text block exists only so a client that
 * ignores structured content still shows something readable.
 *
 * The error object itself is defined in `domain/errors.ts` and is the same
 * contract the CLI prints. One shape, two surfaces.
 */

export const toolTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const toolErrorResultSchema = z.object({
  isError: z.literal(true),
  content: z.array(toolTextContentSchema),
  structuredContent: z.object({ error: uvpErrorSchema }),
});
export type ToolErrorResult = z.infer<typeof toolErrorResultSchema>;

/**
 * Build the failure result for a tool call.
 *
 * The text block restates the message and the remediation rather than dumping
 * the error as JSON. A model reading only the text still learns what to do; a
 * model reading `structuredContent` gets the same information with the codes
 * intact.
 */
export const toolErrorResult = (error: z.infer<typeof uvpErrorSchema>): ToolErrorResult => ({
  isError: true,
  content: [
    {
      type: "text",
      text: `${error.message}\n\nNext: ${error.remediation.action}\nCode: ${error.code}`,
    },
  ],
  structuredContent: { error },
});
