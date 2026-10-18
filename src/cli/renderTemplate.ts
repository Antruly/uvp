import { shortDigest } from "../domain/identity.js";
import { bytes, oneLine, row } from "./format.js";
import { at, bool, list, num, str, strings } from "./readOutput.js";

/**
 * Human renderings for the template-store tools.
 *
 * Each of these answers the question the command was asked — what matched, what
 * was read, what was written, what was scanned — in the first line, and then
 * prints the detail that changes what a person does next.
 */

const fileSummary = (files: readonly unknown[]): string => {
  const total = files.reduce<number>((sum, file) => sum + (num(at(file, "bytes")) ?? 0), 0);
  return `${String(files.length)} file(s), ${bytes(total)}`;
};

const categoryLine = (output: Record<string, unknown>): string => {
  const framework = str(output["framework"]);
  return framework === "" ? str(output["category"]) : `${str(output["category"])} / ${framework}`;
};

export const renderTemplateSearch = (output: Record<string, unknown>): string[] => {
  const matches = list(output["matches"]);
  const total = num(output["total"]) ?? matches.length;
  const lines = [
    row("templates", `${String(matches.length)} shown of ${String(total)} match(es)`),
    row(
      "page",
      `offset ${String(num(output["offset"]) ?? 0)}, limit ${String(num(output["limit"]) ?? 0)}` +
        `${bool(output["truncated"]) === true ? ", truncated" : ""}`,
    ),
  ];

  for (const match of matches) {
    const reference = `${str(at(match, "id"))}@${str(at(match, "version"))}`;
    const meta = [
      str(at(match, "category")),
      str(at(match, "framework")),
      ...strings(at(match, "tags")),
    ]
      .filter((part) => part !== "")
      .join(" ");
    lines.push(
      row(
        "match",
        `${reference}  ${meta}${meta === "" ? "" : "  "}score ${String(num(at(match, "score")) ?? 0)}`,
      ),
    );
    const description = str(at(match, "description"));
    if (description !== "") lines.push(`  ${oneLine(description)}`);
    const matchedOn = strings(at(match, "matched_on"));
    if (matchedOn.length > 0) lines.push(`  matched: ${matchedOn.join(", ")}`);
    if (bool(at(match, "unverified")) === true) {
      lines.push("  unverified: no licence or provenance");
    }
  }

  for (const entry of list(output["corrupt"])) {
    lines.push(
      row("corrupt", `${str(at(entry, "path"))}: ${strings(at(entry, "problems")).join("; ")}`),
    );
  }
  return lines;
};

export const renderTemplateGet = (output: Record<string, unknown>): string[] => {
  const files = list(output["files"]);
  return [
    row("package", `${str(output["id"])}@${str(output["version"])}  ${str(output["name"])}`),
    row("category", categoryLine(output)),
    row("files", fileSummary(files)),
    row("digest", shortDigest(str(output["digest"]))),
    row("store", str(output["path"])),
    ...(bool(output["unverified"]) === true
      ? [row("trust", "unverified: no licence or provenance")]
      : []),
  ];
};

export const renderTemplateValidate = (output: Record<string, unknown>): string[] => [
  row("valid", `${str(output["id"])}@${str(output["version"])}  ${str(output["name"])}`),
  row("category", categoryLine(output)),
  row("files", fileSummary(list(output["files"]))),
  row("digest", shortDigest(str(output["digest"]))),
  row("source", str(output["source_dir"])),
  ...(bool(output["unverified"]) === true
    ? [row("trust", "unverified: no licence or provenance")]
    : []),
];

export const renderTemplateImport = (output: Record<string, unknown>): string[] => {
  const scan = at(output, "scan");
  const findings = list(at(scan, "findings"));
  const dryRun = bool(output["dry_run"]) === true;
  const lines = [
    row(
      "import",
      `${dryRun ? "dry run" : "imported"} ${str(output["id"])}@${str(output["version"])}` +
        `${bool(output["replaced"]) === true ? "  (replaced)" : ""}`,
    ),
  ];
  const path = str(output["path"]);
  if (path !== "") lines.push(row("store", path));
  const retained = str(output["retained"]);
  if (retained !== "") lines.push(row("retained", retained));
  lines.push(
    row(
      "scan",
      `${String(list(at(scan, "scanned")).length)} read, ` +
        `${String(list(at(scan, "skipped")).length)} skipped, ` +
        `${String(findings.length)} finding(s)` +
        `${bool(at(scan, "truncated")) === true ? ", truncated" : ""}`,
    ),
  );
  for (const finding of findings) {
    lines.push(
      row(
        "finding",
        `${str(at(finding, "path"))}:${String(num(at(finding, "line")) ?? 0)} ` +
          `${str(at(finding, "rule"))} ${str(at(finding, "redacted"))}`,
      ),
    );
  }
  return lines;
};

export const renderTemplateExport = (output: Record<string, unknown>): string[] => [
  row("exported", `${str(output["id"])}@${str(output["version"])}`),
  row("target", str(output["path"])),
  row("files", fileSummary(list(output["files"]))),
  row("digest", shortDigest(str(output["digest"]))),
];

export const renderTemplateRemove = (output: Record<string, unknown>): string[] => {
  const lines = [row("removed", str(output["removed"]))];
  const retained = str(output["retained"]);
  if (retained !== "") lines.push(row("retained", retained));
  return lines;
};
