import { row, rows } from "./format.js";
import { at, list, obj, str } from "./readOutput.js";
import {
  renderBuild,
  renderBundleDiff,
  renderDoctor,
  renderRun,
  renderRunStop,
  renderVerify,
  renderWorkspaceCreate,
} from "./renderProject.js";
import { webRenderers } from "./renderWeb.js";

/**
 * Result output.
 *
 * `--json` prints the result object verbatim and stops there; the human form
 * prints a tool-specific summary and then the envelope. Both go to stdout, and
 * both carry the same facts — the human form is a rendering, not a different
 * answer.
 *
 * Failures go to stderr in both modes. stdout is reserved for results so that
 * `uvp build --json | jq` never has to distinguish "the build failed" from "uvp
 * could not parse your flag" by inspecting the shape of what it received: the
 * first is a result with `succeeded: false`, the second never reaches stdout.
 */

type Renderer = (output: Record<string, unknown>) => string[];

const RENDERERS: Readonly<Record<string, Renderer>> = {
  uvp_doctor: renderDoctor,
  uvp_workspace_create: renderWorkspaceCreate,
  uvp_build: renderBuild,
  uvp_run: renderRun,
  uvp_run_stop: renderRunStop,
  uvp_verify: renderVerify,
  uvp_bundle_diff: renderBundleDiff,
  ...webRenderers,
};

/**
 * The envelope, condensed.
 *
 * `unknowns` and `limitations` are printed in full and are never suppressed by a
 * quiet flag: they are the two fields that most often change what a reader should
 * do next, and a rendering that hid them behind `--verbose` would be a rendering
 * that made results look better than they are.
 */
export const envelopeLines = (output: Record<string, unknown>): string[] => {
  const lines: string[] = [];
  const evidence = list(output["evidence"]);
  const provider = obj(output["provider"]);
  lines.push(
    row(
      "adapter",
      `${str(provider["id"], "?")} ${str(provider["version"], "")} ${str(provider["platform"], "")}`.trim(),
    ),
  );
  if (evidence.length > 0) {
    lines.push(
      row(
        "evidence",
        evidence
          .map((entry) => {
            const coverage = obj(at(entry, "coverage"));
            return `${str(at(entry, "kind"))}:${str(coverage["status"], "?")}`;
          })
          .join("  "),
      ),
    );
  }

  const unknowns = list(output["unknowns"]);
  if (unknowns.length > 0) {
    lines.push(row("unknowns", `${String(unknowns.length)} unanswered`));
    for (const unknown of unknowns) {
      lines.push(`  ? ${str(at(unknown, "question"))}  [${str(at(unknown, "reason"))}]`);
      const blockedBy = str(at(unknown, "blocked_by"));
      if (blockedBy !== "") lines.push(`    blocked by: ${blockedBy}`);
    }
  }

  const limitations = list(output["limitations"]);
  if (limitations.length > 0) {
    lines.push(
      ...rows(
        "limits",
        limitations.map((entry) => `- ${str(entry)}`),
      ),
    );
  }

  return lines;
};

/** The full human rendering of one tool result. */
export const renderResult = (output: Record<string, unknown>): string => {
  const tool = str(output["tool"]);
  const renderer = RENDERERS[tool];
  const body = renderer === undefined ? [JSON.stringify(output, null, 2)] : renderer(output);
  return [...body, "", ...envelopeLines(output)].join("\n");
};

/** The error contract, for stderr, in whichever form the caller asked for. */
export const renderFailure = (error: unknown, json: boolean): string => {
  if (json) return JSON.stringify(error, null, 2);
  const code = str(at(error, "code"), "execution_failure");
  const message = str(at(error, "message"), String(error));
  const action = str(at(obj(error)["remediation"], "action"));
  const details = obj(error)["details"];
  const lines = [`${code}: ${message}`];
  if (action !== "") lines.push(`  remedy: ${action}`);
  if (details !== undefined && Object.keys(obj(details)).length > 0) {
    lines.push(`  details: ${JSON.stringify(details)}`);
  }
  return lines.join("\n");
};

export interface OutputStreams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export const processStreams = (): OutputStreams => ({
  out: (text) => {
    process.stdout.write(`${text}\n`);
  },
  err: (text) => {
    process.stderr.write(`${text}\n`);
  },
});

export const emitResult = (
  streams: OutputStreams,
  output: Record<string, unknown>,
  json: boolean,
): void => {
  streams.out(json ? JSON.stringify(output, null, 2) : renderResult(output));
};

export const emitFailure = (streams: OutputStreams, error: unknown, json: boolean): void => {
  streams.err(renderFailure(error, json));
};
