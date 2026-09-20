"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeInteger = encodeInteger;
exports.decodeInteger = decodeInteger;
const errors_1 = require("./errors");
/**
 * HPACK integer representation (RFC 7541, Section 5.1).
 *
 * Integers consist of an N-bit prefix inside the current octet followed,
 * when the prefix is saturated, by a base-128 varint.
 */
/**
 * Maximum total number of octets accepted for a single integer while
 * decoding (prefix octet included). HPACK header table sizes are bounded
 * by 2^32-1, which encodes in at most 6 octets with an 8-bit prefix;
 * anything longer is treated as malformed.
 */
const MAX_INTEGER_BYTES = 12;
/**
 * Encode `value` into the `prefixBits`-bit prefix of `firstByte`.
 *
 * @param firstByte Octet in which the prefix lives; its leading
 *                  (8 - prefixBits) bits are preserved.
 * @param prefixBits Prefix width N, 1..8.
 * @param value Non-negative integer to encode.
 */
function encodeInteger(firstByte, prefixBits, value) {
    if (!Number.isInteger(prefixBits) ||
        prefixBits < 1 ||
        prefixBits > 8) {
        throw new errors_1.HpackEncodingError(`integer prefix must be between 1 and 8 bits, got ${prefixBits}`, 'INTEGER_ENCODING');
    }
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new errors_1.HpackEncodingError(`integer value must be a non-negative safe integer, got ${String(value)}`, 'INTEGER_ENCODING');
    }
    const prefixMask = (1 << prefixBits) - 1;
    if (value < prefixMask) {
        return Buffer.from([(firstByte & ~prefixMask) | value]);
    }
    const bytes = [(firstByte & ~prefixMask) | prefixMask];
    let rest = value - prefixMask;
    while (rest >= 128) {
        bytes.push((rest % 128) + 128);
        rest = Math.floor(rest / 128);
    }
    bytes.push(rest);
    return Buffer.from(bytes);
}
/**
 * Decode an HPACK integer starting at `offset` in `buf`.
 *
 * @param prefixBits Prefix width N, 1..8, of the first octet.
 */
function decodeInteger(buf, offset, prefixBits) {
    if (!Number.isInteger(prefixBits) ||
        prefixBits < 1 ||
        prefixBits > 8) {
        throw new errors_1.HpackDecodingError(`integer prefix must be between 1 and 8 bits, got ${prefixBits}`, 'INTEGER_DECODING');
    }
    if (offset >= buf.length) {
        throw new errors_1.HpackDecodingError('truncated header block while reading integer prefix', 'TRUNCATED');
    }
    const prefixMask = (1 << prefixBits) - 1;
    let value = buf[offset] & prefixMask;
    let length = 1;
    if (value < prefixMask) {
        return { value, length };
    }
    let shift = 0;
    while (true) {
        if (offset + length >= buf.length) {
            throw new errors_1.HpackDecodingError('truncated header block while reading integer continuation', 'TRUNCATED');
        }
        if (length >= MAX_INTEGER_BYTES) {
            throw new errors_1.HpackDecodingError('integer representation too long', 'INTEGER_DECODING');
        }
        const b = buf[offset + length];
        length += 1;
        const payload = b & 0x7f;
        // Add this base-128 digit (payload * 128^shift) to the accumulated
        // value using only exact, safe-integer arithmetic; loss of precision
        // or overflow means the wire value cannot be represented.
        const digitPow = 2 ** shift;
        const additionIsSafe = shift <= 53 &&
            digitPow <= Number.MAX_SAFE_INTEGER &&
            payload <= (Number.MAX_SAFE_INTEGER - value) / digitPow;
        if (!additionIsSafe) {
            throw new errors_1.HpackDecodingError('integer value too large', 'INTEGER_DECODING');
        }
        if ((b & 0x80) === 0) {
            // Note: the Section 5.1 pseudocode does not mandate rejecting
            // non-minimal encodings (a saturated prefix followed by extra zero
            // digits decodes fine), so redundant digits are accepted for
            // interoperability; only truncation and value overflow are errors.
            value += payload * digitPow;
            return { value, length };
        }
        // Interior zero-payload continuation octets (e.g. 0x80 in the
        // encoding of 159 with a 5-bit prefix: 1f 80 01) are legal digits.
        value += payload * digitPow;
        shift += 7;
    }
}
