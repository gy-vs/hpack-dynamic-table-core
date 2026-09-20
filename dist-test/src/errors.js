"use strict";
/**
 * HPACK subset error hierarchy (RFC 7541).
 *
 * Every error thrown by this library extends {@link HpackError}, so callers
 * can catch HPACK-specific failures with a single `instanceof` check.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HuffmanUnsupportedError = exports.HpackDecodingError = exports.HpackEncodingError = exports.HpackError = void 0;
/** Base class for all HPACK errors. */
class HpackError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'HpackError';
        this.code = code;
    }
}
exports.HpackError = HpackError;
/** Thrown when the encoder refuses an input header or parameter. */
class HpackEncodingError extends HpackError {
    constructor(message, code = 'ENCODING') {
        super(code, message);
        this.name = 'HpackEncodingError';
    }
}
exports.HpackEncodingError = HpackEncodingError;
/** Thrown when a header block cannot be decoded. */
class HpackDecodingError extends HpackError {
    constructor(message, code = 'DECODING') {
        super(code, message);
        this.name = 'HpackDecodingError';
    }
}
exports.HpackDecodingError = HpackDecodingError;
/**
 * Thrown when an encoded header field string carries the Huffman flag
 * (H bit set) or Huffman encoding is requested on the encoder side.
 * Huffman coding is intentionally not implemented by this subset.
 */
class HuffmanUnsupportedError extends HpackError {
    constructor(direction) {
        super('HUFFMAN_UNSUPPORTED', direction === 'decode'
            ? 'Huffman-encoded string literal encountered (H bit set); Huffman coding is not supported by this HPACK subset'
            : 'Huffman coding requested but not supported by this HPACK subset');
        this.name = 'HuffmanUnsupportedError';
    }
}
exports.HuffmanUnsupportedError = HuffmanUnsupportedError;
