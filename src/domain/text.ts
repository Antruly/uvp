/**
 * Text boundaries a naive slice can break.
 *
 * The supervision port returns a UTF-8-safe tail bounded by bytes, but a caller
 * cuts it again for a tool result — `WorkspaceService` keeps the last 4,096 code
 * units. That second cut is by UTF-16 units and can land between the halves of a
 * surrogate pair, producing a string an MCP caller receives as an escaped lone
 * surrogate. Dropping the orphaned low surrogate keeps the text valid at the cost
 * of one code unit; the data a caller needs is at the end of the tail anyway.
 */

/**
 * The last `maxCodeUnits` of `text`, without starting inside a surrogate pair.
 *
 * A cap of zero or less is an empty tail, not the whole string: the caller asked
 * for no text. A cap at or above the string's length returns the string unchanged.
 */
export const tailText = (text: string, maxCodeUnits: number): string => {
  if (maxCodeUnits <= 0) return "";
  if (text.length <= maxCodeUnits) return text;
  let start = text.length - maxCodeUnits;
  const first = text.charCodeAt(start);
  // A low surrogate here is the second half of a pair whose first half is before
  // the cut; keeping it would make the result invalid UTF-16.
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return text.slice(start);
};
