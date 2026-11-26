import { gzipSync } from "node:zlib";

/**
 * Minimal ustar fixtures for the archive reader.
 *
 * Everything is built from `Buffer` and `node:zlib`, so the tests exercise the
 * reader without depending on a `tar` binary or on how a host's tar happens to
 * pad a header. Each entry is a full 512-byte header plus its padded data; the
 * archive ends with the two zero blocks ustar requires.
 */

export const TAR_BLOCK_SIZE = 512;

export interface TarFixtureEntry {
  readonly path: string;
  readonly bytes?: Buffer;
  /** Store the path as ustar `prefix` + `name` instead of `name` alone. */
  readonly usePrefix?: boolean;
  /** The one-character typeflag; defaults to "0" (regular file). */
  readonly type?: string;
  /** Override the size written in the header without changing the payload. */
  readonly declaredSize?: number;
  /** Override the checksum field, to corrupt a header deliberately. */
  readonly checksum?: number;
}

const writeField = (block: Buffer, offset: number, length: number, value: string): void => {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > length) {
    throw new Error(`fixture field is longer than ${length} bytes: '${value}'`);
  }
  encoded.copy(block, offset);
};

const octal = (value: number, length: number): string =>
  `${value.toString(8).padStart(length - 1, "0")}\0`;

const checksumOctal = (value: number): string => `${value.toString(8).padStart(6, "0")}\0 `;

/** Build an uncompressed ustar archive. */
export const makeTar = (entries: readonly TarFixtureEntry[]): Buffer => {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.bytes ?? Buffer.alloc(0);
    const declaredSize = entry.declaredSize ?? data.byteLength;
    const slash = entry.path.lastIndexOf("/");
    const usePrefix = entry.usePrefix === true && slash > 0;
    const name = usePrefix ? entry.path.slice(slash + 1) : entry.path;
    const prefix = usePrefix ? entry.path.slice(0, slash) : "";

    const header = Buffer.alloc(TAR_BLOCK_SIZE);
    writeField(header, 0, 100, name);
    writeField(header, 100, 8, octal(0o644, 8));
    writeField(header, 108, 8, octal(0, 8));
    writeField(header, 116, 8, octal(0, 8));
    writeField(header, 124, 12, octal(declaredSize, 12));
    writeField(header, 136, 12, octal(0, 12));
    header.fill(0x20, 148, 156);
    writeField(header, 156, 1, entry.type ?? "0");
    writeField(header, 257, 6, "ustar\0");
    writeField(header, 263, 2, "00");
    writeField(header, 345, 155, prefix);

    let sum = 0;
    for (const byte of header) sum += byte;
    writeField(
      header,
      148,
      8,
      entry.checksum === undefined ? checksumOctal(sum) : octal(entry.checksum, 8),
    );

    blocks.push(header);
    const padded = Math.ceil(declaredSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (padded > 0) {
      if (data.byteLength > padded) {
        throw new Error(`fixture entry '${entry.path}' has more bytes than it declares`);
      }
      blocks.push(Buffer.concat([data, Buffer.alloc(padded - data.byteLength)]));
    }
  }
  blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return Buffer.concat(blocks);
};

/** Build a gzipped ustar archive. */
export const makeTarGz = (entries: readonly TarFixtureEntry[]): Buffer =>
  gzipSync(makeTar(entries), { level: 9 });
