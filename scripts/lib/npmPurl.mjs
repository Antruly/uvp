/**
 * A package URL, as the purl spec spells one for npm.
 *
 * The scope's `@` is percent-encoded and the `/` after it is not: the namespace
 * is `@scope` and the name is the part after the slash, so encoding the slash
 * would move the boundary. Measured against `npm sbom`'s own output rather than
 * recalled — it emits `pkg:npm/%40modelcontextprotocol/core@2.3.1`.
 *
 * One owner for the spelling: the SBOM generator writes it, and the
 * GitHub Packages mirror checks the document it wrote against it. A second copy
 * in the check would let the two drift while both looked right.
 */
export const npmPurl = (name, version) => {
  const scoped = name.startsWith("@");
  const encoded = scoped ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
};
