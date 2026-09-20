import { HuffmanUnsupportedError } from "./errors.js";
import { Reader, encodeInteger } from "./integer.js";

/**
 * String literal representation (RFC 7541, Section 5.2).
 *
 * Only raw bytes are supported. The H (Huffman) bit is rejected explicitly.
 */

const HUFFMAN_BIT = 0x80;

/** Encode a string as raw (never Huffman) bytes with a 7-bit length prefix. */
export function encodeString(value: string | Buffer): Buffer {
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = encodeInteger(data.length, 7);
  return Buffer.concat([length, data]);
}

/** Read a string literal whose first byte has not yet been consumed. */
export function readString(reader: Reader): Buffer {
  const { firstByte, value: length } = reader.readPrefixedInteger(7);
  if ((firstByte & HUFFMAN_BIT) !== 0) {
    throw new HuffmanUnsupportedError();
  }
  return reader.readBytes(length);
}
