#!/usr/bin/env node
import { parseArgs } from "node:util";

import { emitGeneratedFile, finishCheck } from "./lib/generated-file.mjs";
import { importCompiled } from "./lib/paths.mjs";

/**
 * Publish the failure contract as JSON Schema.
 *
 * The error contract is the one part of the surface a client has to handle
 * without being able to call anything first — a server that fails to start
 * cannot explain itself over the protocol. Publishing the schema means a client
 * can validate and render errors without importing Zod or reading TypeScript.
 *
 * Generated from the Zod schema in `domain/errors.ts`, so it cannot describe a
 * shape the code does not produce.
 */

const OUTPUT = "docs/error-contract.schema.json";

const { values } = parseArgs({
  options: {
    check: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`Usage: node scripts/generate-error-schema.mjs [--check]

Writes ${OUTPUT} from src/domain/errors.ts and src/contracts/errorSchemas.ts.
Requires dist/ — run \`npm run compile\` first.`);
  process.exit(0);
}

const { uvpErrorSchema } = await importCompiled("domain/errors.js");
const { toolErrorResultSchema } = await importCompiled("contracts/errorSchemas.js");
const { z } = await import("zod");

const strip = (schema) => {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" });
  delete json.$schema;
  return json;
};

const document = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/uvp-labs/uvp/docs/error-contract.schema.json",
  title: "uvp error contract",
  description:
    "The closed shape of a uvp failure. Same contract in the CLI and over MCP; over MCP it arrives under structuredContent.error with isError set.",
  $defs: {
    uvp_error: strip(uvpErrorSchema),
    tool_error_result: strip(toolErrorResultSchema),
  },
  $ref: "#/$defs/tool_error_result",
};

const contents = `${JSON.stringify(document, null, 2)}\n`;

const result = await emitGeneratedFile({
  relative: OUTPUT,
  contents,
  check: values.check,
});

if (values.check) process.exit(finishCheck([result], { label: "error contract schema" }));

console.log(`wrote ${OUTPUT}`);
