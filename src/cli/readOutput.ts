/**
 * Reading a tool result without lying about its type.
 *
 * Output objects arrive as `Record<string, unknown>` because that is what the
 * contract's own parse produces at this boundary. Field-by-field re-validation
 * here would be a second definition of the output shape, so these helpers read
 * defensively and fall back rather than throwing: a renderer that crashes on an
 * unexpected field is worse than one that prints a blank, because the JSON output
 * on stdout is still correct and the reader would lose it to a stack trace.
 */

export const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

export const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const obj = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

export const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

export const at = (value: unknown, key: string): unknown => obj(value)[key];

export const strings = (value: unknown): readonly string[] =>
  list(value).flatMap((entry) => (typeof entry === "string" ? [entry] : []));

/** `yes` / `no` / `unknown` — three states, because a missing boolean is not `false`. */
export const yesNo = (value: unknown): string => {
  const flag = bool(value);
  return flag === undefined ? "unknown" : flag ? "yes" : "no";
};
