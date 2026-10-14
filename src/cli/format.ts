/**
 * Formatting primitives for the human rendering.
 *
 * The JSON output is the authoritative one; this rendering exists so a person
 * does not have to read JSON to answer "did it work". It is allowed to drop
 * fields — but not to say something the JSON does not, and not to hide a
 * non-empty `unknowns` or `limitations`, which are the two fields most likely to
 * change what the reader does next.
 */

export const LABEL_WIDTH = 12;

/** `ready       yes`, with the label column padded so values line up. */
export const row = (label: string, value: string): string =>
  `${label.padEnd(LABEL_WIDTH)} ${value}`;

/** A row whose value runs onto continuation lines, indented under the first. */
export const rows = (label: string, values: readonly string[]): string[] =>
  values.length === 0
    ? []
    : values.map((value, index) =>
        index === 0 ? row(label, value) : `${" ".repeat(LABEL_WIDTH + 1)}${value}`,
      );

export const bytes = (count: number): string => {
  if (count < 1024) return `${String(count)} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KiB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MiB`;
};

export const millis = (value: number): string =>
  value < 1000 ? `${String(value)} ms` : `${(value / 1000).toFixed(2)} s`;

/** One-line, whitespace-collapsed text, for a value that may contain newlines. */
export const oneLine = (text: string, max = 120): string => {
  const collapsed = text.replaceAll(/\s+/gu, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
};

/** Truncate a value for display, saying so, rather than printing a prefix silently. */
export const clip = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n… (${String(text.length - max)} more characters)`;

/** A `format`-free column layout: each column's width is the widest cell in it. */
export const table = (headers: readonly string[], body: readonly (readonly string[])[]): string => {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...body.map((line) => (line[column] ?? "").length)),
  );
  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, column) =>
        column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
      )
      .join("  ")
      .trimEnd();
  return [render(headers), ...body.map(render)].join("\n");
};

/**
 * A two-column list with no header: a name, then a description.
 *
 * Separate from `table` because help's first column is a command name rather
 * than a data field, and the width is the longest name rather than the longest
 * cell that happens to be there — so the indentation is the same whichever
 * command's help is being read.
 */
export const commandList = (entries: readonly (readonly string[])[]): string[] => {
  const width = Math.max(...entries.map((cells) => (cells[0] ?? "").length));
  return entries.map((cells) => `  ${(cells[0] ?? "").padEnd(width)}  ${cells[1] ?? ""}`.trimEnd());
};
