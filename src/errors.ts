/**
 * HPACK (RFC 7541) subset implementation.
 *
 * Supported:
 *  - indexed header field representation (Section 6.1)
 *  - literal header field with incremental indexing (Section 6.2.1)
 *  - literal header field without indexing (Section 6.2.2)
 *  - literal header field never-indexed (Section 6.2.3)
 *  - integer representation (Section 5.1), all prefix sizes 1..8
 *  - dynamic table size update (Section 6.3)
 *
 * Unsupported:
 *  - Huffman encoding (Section 5.2): any H flag is a hard error.
 */

/** Base class for every error raised while encoding or decoding a header block. */
export class HpackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HpackError";
  }
}

/** Raised when a header block carries the Huffman bit (H = 1). Huffman is not implemented. */
export class HuffmanUnsupportedError extends HpackError {
  constructor(message = "Huffman encoding is not supported by this HPACK subset") {
    super(message);
    this.name = "HuffmanUnsupportedError";
  }
}

/** Raised on malformed input, out-of-range indices, truncation or protocol violations. */
export class HpackDecodingError extends HpackError {
  constructor(message: string) {
    super(message);
    this.name = "HpackDecodingError";
  }
}
