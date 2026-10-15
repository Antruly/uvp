/**
 * The small glob dialect this repository's checks match paths with.
 *
 * `**`, `*` and `{a,b}` are enough for every pattern that appears here — test
 * project `include`/`exclude` entries and VitePress's `srcExclude` — and a
 * hand-written matcher is preferable to a dependency that has to agree with the
 * glob library behind those two. When the two disagree the check is wrong about
 * the thing it exists to decide: `verify-test-discovery` would report a file as
 * unclaimed that Vitest runs perfectly well, and `verify-docs-interpolation`
 * would scan a page VitePress never builds.
 *
 * Matching is full-path, so patterns must cover the whole of a
 * repository-relative POSIX path.
 */

export const globToRegExp = (glob) => {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        // `**/` matches zero or more directories; a bare `**` matches anything.
        if (glob[index + 2] === "/") {
          pattern += "(?:[^/]+/)*";
          index += 2;
        } else {
          pattern += ".*";
          index += 1;
        }
      } else {
        pattern += "[^/]*";
      }
      continue;
    }
    if (char === "{") {
      const end = glob.indexOf("}", index);
      if (end === -1) throw new Error(`Unbalanced brace in glob: ${glob}`);
      const alternatives = glob
        .slice(index + 1, end)
        .split(",")
        .map((part) => part.replaceAll(/[.+^${}()|[\]\\]/gu, "\\$&"));
      pattern += `(?:${alternatives.join("|")})`;
      index = end;
      continue;
    }
    pattern += char.replaceAll(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${pattern}$`, "u");
};
