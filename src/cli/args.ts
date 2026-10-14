import { UvpFailure } from "../domain/errors.js";

/**
 * Argument parsing.
 *
 * Hand-written on purpose. The alternative — deriving flags from the contract's
 * Zod schema — produces `--max-body-bytes` where the documentation says
 * `--max-bytes`, and gets positional arguments wrong, because "which arguments
 * are positional" is not a property of a schema. A schema says `upstream` is a
 * string; it cannot say that `uvp capture start http://…` puts it after the verb.
 *
 * So this layer maps words to a structured object, and the contract validates
 * that object. The CLI never decides what a valid input *is*; it only decides
 * what the words mean.
 *
 * Both a `values` record and an ordered `occurrences` list are kept. `values` is
 * what almost every command wants; `occurrences` exists for `--request` … several
 * `--assert` … where the association between two flags is their order, and a
 * record has thrown that order away.
 */

export type FlagValue = boolean | string | number | readonly string[];

export interface FlagSpec {
  /** The canonical key this flag sets. Matches the contract field where there is one. */
  readonly name: string;
  /** Accepted spellings, without leading dashes. The first is the documented one. */
  readonly alias?: readonly string[];
  /**
   * How many tokens one occurrence consumes: `pair` takes two (a method and a
   * path, a name and a value), `list` takes one but accumulates, and the rest
   * take one.
   *
   * There is no separate kind for a repeated switch. A tally is read from
   * `occurrences`, which records every occurrence at every arity — so a kind
   * that stored a number would be a second way to compute a value the parser
   * already reports, and one that could disagree with it.
   */
  readonly type: "boolean" | "string" | "number" | "pair" | "list";
  /** The value placeholder shown in help, e.g. `PATH`. */
  readonly value?: string;
  readonly description: string;
}

export interface FlagOccurrence {
  readonly name: string;
  readonly values: readonly string[];
}

export interface ParsedArgv {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, FlagValue>>;
  readonly occurrences: readonly FlagOccurrence[];
  /** True when `--help` or `-h` appeared; the caller prints usage and exits 0. */
  readonly help: boolean;
}

/** Flags every command accepts, so `--help` and `--json` need not be declared twice. */
export const UNIVERSAL_FLAGS: readonly FlagSpec[] = [
  { name: "json", type: "boolean", description: "Print the full result as JSON on stdout." },
  { name: "help", alias: ["h"], type: "boolean", description: "Print usage and exit." },
];

const looksLikeFlag = (token: string): boolean => token.startsWith("-") && token !== "-";

/**
 * A declared function, not a const arrow.
 *
 * TypeScript only treats a call as never-returning when the callee is a function
 * declaration or an explicitly annotated const. Written as an arrow, every branch
 * below would need its own `throw` for the compiler to accept the code that
 * follows — which is how a "fail" helper ends up duplicated at twenty call sites.
 */
export function flagError(message: string, details?: Record<string, unknown>): never {
  throw new UvpFailure({
    code: "invalid_request",
    message,
    remediation: { action: "Run the command with --help to see the accepted flags." },
    ...(details === undefined ? {} : { details }),
  });
}

/** Levenshtein distance, capped: used only to suggest a spelling, never to accept one. */
const distance = (a: string, b: string): number => {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, index) => index);
  for (let row = 1; row < rows; row += 1) {
    const current = [row, ...Array.from<number>({ length: cols - 1 }).fill(0)];
    for (let col = 1; col < cols; col += 1) {
      const substitution = (previous[col - 1] ?? 0) + (a[row - 1] === b[col - 1] ? 0 : 1);
      current[col] = Math.min((previous[col] ?? 0) + 1, (current[col - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[cols - 1] ?? cols;
};

const suggestion = (typed: string, known: readonly string[]): string => {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of known) {
    const candidateDistance = distance(typed, candidate);
    if (candidateDistance < bestDistance) {
      bestDistance = candidateDistance;
      best = candidate;
    }
  }
  return best === undefined ? "" : ` Did you mean --${best}?`;
};

const parseNumber = (name: string, raw: string): number => {
  // `Number("")` and `Number(" ")` are `0`, and zero is a number, so without the
  // digit check an empty value is accepted as a valid zero: `--port ""` asks for
  // port 0 and `--timeout ""` for an immediate timeout, both silently. Requiring
  // a digit keeps "the caller typed nothing" distinct from "the caller typed 0".
  const trimmed = raw.trim();
  if (!/\d/u.test(trimmed)) flagError(`--${name} expects a number, got "${raw}".`);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) flagError(`--${name} expects a number, got "${raw}".`);
  return value;
};

/**
 * Parse `argv` against a flag table.
 *
 * A missing required flag is *not* checked here: `--help` has to be reachable on
 * a command whose required flags were not supplied, and that is the whole reason
 * the flag exists. Required-ness is enforced by the contract's schema, where it
 * is declared once.
 */
export const parseArgv = (argv: readonly string[], flags: readonly FlagSpec[]): ParsedArgv => {
  const specs = [...flags, ...UNIVERSAL_FLAGS];
  const bySpelling = new Map<string, FlagSpec>();
  for (const spec of specs) {
    bySpelling.set(spec.name, spec);
    for (const alias of spec.alias ?? []) bySpelling.set(alias, spec);
  }

  const positionals: string[] = [];
  const occurrences: FlagOccurrence[] = [];
  const values: Record<string, FlagValue> = {};
  let help = false;
  let index = 0;
  let onlyPositionals = false;

  const record = (spec: FlagSpec, raw: readonly string[]): void => {
    occurrences.push({ name: spec.name, values: raw });
    switch (spec.type) {
      case "boolean":
        values[spec.name] = true;
        return;
      case "number":
        values[spec.name] = parseNumber(spec.name, raw[0] ?? "");
        return;
      case "pair":
        // Stored as the raw two-element array, because a pair has no single
        // value to collapse to and joining it would invent a separator the
        // caller never wrote. `occurrences` carries the same array in order.
        values[spec.name] = raw;
        return;
      case "list": {
        const existing = values[spec.name];
        const list = Array.isArray(existing) ? [...existing] : [];
        list.push(...raw);
        values[spec.name] = list;
        return;
      }
      case "string":
        values[spec.name] = raw[0] ?? "";
        return;
      default: {
        // Every other kind is handled above, so reaching here means a kind was
        // added to `FlagSpec` without a branch — and a missing branch does not
        // fail loudly, it drops the flag's value while the token is consumed and
        // no error is raised. Assigning to `never` turns that silent loss into a
        // compile error, which is the only reason this loop is worth having.
        const unhandled: never = spec.type;
        throw new Error(`Unhandled flag type: ${String(unhandled)}`);
      }
    }
  };

  while (index < argv.length) {
    const token = argv[index] ?? "";
    index += 1;

    if (onlyPositionals || !looksLikeFlag(token)) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      onlyPositionals = true;
      continue;
    }

    const body = token.replace(/^--?/u, "");
    const [spelling, inline] = body.includes("=")
      ? [body.slice(0, body.indexOf("=")), body.slice(body.indexOf("=") + 1)]
      : [body, undefined];

    // `--no-verify-tls` is the documented way to turn a defaulted-on flag off.
    const negated = spelling.startsWith("no-") ? spelling.slice(3) : undefined;
    const spec =
      bySpelling.get(spelling) ?? (negated === undefined ? undefined : bySpelling.get(negated));

    if (spec === undefined) {
      flagError(`Unknown flag --${spelling}.${suggestion(spelling, [...bySpelling.keys()])}`, {
        flag: spelling,
      });
    }
    if (negated !== undefined) {
      if (spec.type !== "boolean") flagError(`--no-${negated} is only meaningful for a switch.`);
      // Checked before the negation is applied, and by the same rule as the
      // plain form below: `--no-tls=true` would otherwise set `tls` to false —
      // the opposite of what was typed — while `--tls=true` is rejected.
      if (inline !== undefined) {
        flagError(`--no-${negated} is a switch and takes no value (got "${inline}").`);
      }
      occurrences.push({ name: spec.name, values: [] });
      values[spec.name] = false;
      continue;
    }
    if (spec.type === "boolean") {
      if (inline !== undefined) {
        flagError(`--${spelling} is a switch and takes no value (got "${inline}").`);
      }
      if (spec.name === "help") help = true;
      record(spec, []);
      continue;
    }

    const arity = spec.type === "pair" ? 2 : 1;
    const consumed: string[] = [];
    if (inline !== undefined) {
      if (spec.type === "pair") {
        flagError(`--${spelling} takes two values, so it cannot use --${spelling}=value.`);
      }
      consumed.push(inline);
    }
    while (consumed.length < arity) {
      const next = argv[index];
      if (next === undefined || looksLikeFlag(next)) {
        flagError(`--${spelling} needs ${String(arity)} value(s), got ${String(consumed.length)}.`);
      }
      consumed.push(next);
      index += 1;
    }
    if (spec.name === "help") help = true;
    record(spec, consumed);
  }

  return { positionals, values, occurrences, help };
};

/** Read a flag as a string, or undefined when it was not supplied. */
export const asString = (parsed: ParsedArgv, name: string): string | undefined => {
  const value = parsed.values[name];
  return typeof value === "string" ? value : undefined;
};

/** Read a repeatable flag. A single occurrence and many are the same shape to a caller. */
export const asList = (parsed: ParsedArgv, name: string): readonly string[] => {
  const value = parsed.values[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
};

export const asNumber = (parsed: ParsedArgv, name: string): number | undefined => {
  const value = parsed.values[name];
  return typeof value === "number" ? value : undefined;
};

export const asBoolean = (parsed: ParsedArgv, name: string): boolean | undefined => {
  const value = parsed.values[name];
  return typeof value === "boolean" ? value : undefined;
};

/**
 * Split `name: value` and `name=value` header arguments.
 *
 * Both spellings appear in the wild and both are unambiguous — a header name
 * cannot contain either character — so refusing one would be pedantry with a
 * support cost.
 */
export const parseHeaders = (entries: readonly string[]): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    const equals = entry.indexOf("=");
    const at = separator === -1 ? equals : equals === -1 ? separator : Math.min(separator, equals);
    if (at <= 0) {
      flagError(`"${entry}" is not a header. Pass it as "name: value".`);
    }
    const name = entry.slice(0, at).trim();
    const value = entry.slice(at + 1).trim();
    if (name === "") flagError(`"${entry}" has an empty header name.`);
    headers[name.toLowerCase()] = value;
  }
  return headers;
};

/** `key=value` pairs, for parameters whose values are strings. */
export const parsePairs = (entries: readonly string[]): Record<string, string> => {
  const pairs: Record<string, string> = {};
  for (const entry of entries) {
    const at = entry.indexOf("=");
    if (at <= 0) flagError(`"${entry}" is not a key=value pair.`);
    pairs[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return pairs;
};

/** Comma-separated or repeated values, de-duplicated in first-seen order. */
export const parseCsv = (entries: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const piece of entry.split(",")) {
      const trimmed = piece.trim();
      if (trimmed !== "") seen.add(trimmed);
    }
  }
  return [...seen];
};

export const requirePositional = (
  parsed: ParsedArgv,
  index: number,
  what: string,
  usage: string,
): string => {
  const value = parsed.positionals[index];
  if (value === undefined || value === "") {
    flagError(`Missing ${what}.`, { usage });
  }
  return value;
};
