import {HpackDecodingError} from './errors';
import {HuffmanUnsupportedError} from './errors';
import {decodeInteger, encodeInteger} from './integer';

/**
 * String literal representation (RFC 7541, Section 5.2).
 *
 * A string is an H flag bit plus a 7-bit length prefix followed by the
 * raw header-name/header-value octets. This subset only emits and accepts
 * raw (non-Huffman) strings; an H bit of 1 yields {@link HuffmanUnsupportedError}.
 */

/**
 * Encode a header-name or header-value as an HPACK string literal.
 * Huffman coding is not supported, so the output always has H = 0.
 */
export function encodeString(value: string | Buffer): Buffer {
  const raw = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const head = encodeInteger(0x00, 7, raw.length);
  return Buffer.concat([head, raw]);
}

export interface DecodedString {
  value: string;
  /** Octets consumed, including the length prefix. */
  length: number;
}

/** Decode an HPACK string literal starting at `offset`. */
export function decodeString(buf: Buffer, offset: number): DecodedString {
  if (offset >= buf.length) {
    throw new HpackDecodingError(
      'truncated header block while reading string header',
      'TRUNCATED'
    );
  }

  const hBit = (buf[offset]! & 0x80) !== 0;
  const len = decodeInteger(buf, offset, 7);
  const start = offset + len.length;
  const end = start + len.value;
  if (end > buf.length) {
    throw new HpackDecodingError(
      'truncated header block while reading string payload',
      'TRUNCATED'
    );
  }

  if (hBit) {
    throw new HuffmanUnsupportedError('decode');
  }

  const value = buf.toString('utf8', start, end);
  return {value, length: end - offset};
}
