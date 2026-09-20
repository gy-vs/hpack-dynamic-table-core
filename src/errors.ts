/**
 * HPACK subset error hierarchy (RFC 7541).
 *
 * Every error thrown by this library extends {@link HpackError}, so callers
 * can catch HPACK-specific failures with a single `instanceof` check.
 */

/** Machine-stable error codes. */
export type HpackErrorCode =
  | 'INTEGER_ENCODING'
  | 'INTEGER_DECODING'
  | 'STRING_DECODING'
  | 'HUFFMAN_UNSUPPORTED'
  | 'INDEX_OUT_OF_RANGE'
  | 'DYNAMIC_TABLE_SIZE'
  | 'ENCODING'
  | 'DECODING'
  | 'TRUNCATED';

/** Base class for all HPACK errors. */
export class HpackError extends Error {
  readonly code: HpackErrorCode;

  constructor(code: HpackErrorCode, message: string) {
    super(message);
    this.name = 'HpackError';
    this.code = code;
  }
}

/** Thrown when the encoder refuses an input header or parameter. */
export class HpackEncodingError extends HpackError {
  constructor(message: string, code: HpackErrorCode = 'ENCODING') {
    super(code, message);
    this.name = 'HpackEncodingError';
  }
}

/** Thrown when a header block cannot be decoded. */
export class HpackDecodingError extends HpackError {
  constructor(message: string, code: HpackErrorCode = 'DECODING') {
    super(code, message);
    this.name = 'HpackDecodingError';
  }
}

/**
 * Thrown when an encoded header field string carries the Huffman flag
 * (H bit set) or Huffman encoding is requested on the encoder side.
 * Huffman coding is intentionally not implemented by this subset.
 */
export class HuffmanUnsupportedError extends HpackError {
  constructor(direction: 'encode' | 'decode') {
    super(
      'HUFFMAN_UNSUPPORTED',
      direction === 'decode'
        ? 'Huffman-encoded string literal encountered (H bit set); Huffman coding is not supported by this HPACK subset'
        : 'Huffman coding requested but not supported by this HPACK subset'
    );
    this.name = 'HuffmanUnsupportedError';
  }
}
