import type { TemplatePackageProblem } from "./templatePackage.js";

/**
 * The problem collector and the value coercions shared by the
 * `uvp.template/1` readers.
 *
 * Validation reports every problem rather than throwing, so each reader
 * appends to one collector and the entry point decides whether the collected
 * set is empty. A reader that returned early would hide the second problem
 * behind the first, and an importer would learn its manifest is wrong one
 * field per attempt.
 */
export class Problems {
  readonly list: TemplatePackageProblem[] = [];

  add(location: string, message: string): void {
    this.list.push({ location, message });
  }

  /** Every key of `record` that the closed schema does not declare. */
  rejectUnknownKeys(
    record: Record<string, unknown>,
    prefix: string,
    allowed: ReadonlySet<string>,
    schema: string = "uvp.template/1",
  ): void {
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) this.add(`${prefix}${key}`, `is not a field of ${schema}`);
    }
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const asInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;
