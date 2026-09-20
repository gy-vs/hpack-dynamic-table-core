"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeString = encodeString;
exports.decodeString = decodeString;
const errors_1 = require("./errors");
const errors_2 = require("./errors");
const integer_1 = require("./integer");
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
function encodeString(value) {
    const raw = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const head = (0, integer_1.encodeInteger)(0x00, 7, raw.length);
    return Buffer.concat([head, raw]);
}
/** Decode an HPACK string literal starting at `offset`. */
function decodeString(buf, offset) {
    if (offset >= buf.length) {
        throw new errors_1.HpackDecodingError('truncated header block while reading string header', 'TRUNCATED');
    }
    const hBit = (buf[offset] & 0x80) !== 0;
    const len = (0, integer_1.decodeInteger)(buf, offset, 7);
    const start = offset + len.length;
    const end = start + len.value;
    if (end > buf.length) {
        throw new errors_1.HpackDecodingError('truncated header block while reading string payload', 'TRUNCATED');
    }
    if (hBit) {
        throw new errors_2.HuffmanUnsupportedError('decode');
    }
    const value = buf.toString('utf8', start, end);
    return { value, length: end - offset };
}
