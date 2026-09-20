"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const integer_1 = require("../src/integer");
const errors_1 = require("../src/errors");
(0, node_test_1.describe)('integer encoding (RFC 7541, Section 5.1 / Appendix C.1)', () => {
    const cases = [
        // RFC 7541 Appendix C.1 examples, with the high "flag" bits retained.
        { first: 0x00, bits: 5, value: 10, hex: '0a' },
        { first: 0x00, bits: 5, value: 1337, hex: '1f9a0a' },
        { first: 0x80, bits: 7, value: 10, hex: '8a' },
        { first: 0x80, bits: 7, value: 42, hex: 'aa' },
        { first: 0x00, bits: 8, value: 10, hex: '0a' },
        { first: 0x00, bits: 8, value: 1337, hex: 'ffba08' },
        { first: 0x00, bits: 8, value: 42, hex: '2a' },
        { first: 0x00, bits: 8, value: 1234, hex: 'ffd307' },
        // Boundary values: exactly at prefix saturation need a continuation.
        { first: 0x00, bits: 5, value: 30, hex: '1e' },
        { first: 0x00, bits: 5, value: 31, hex: '1f00' },
        { first: 0x00, bits: 5, value: 32, hex: '1f01' },
        { first: 0x80, bits: 7, value: 126, hex: 'fe' },
        { first: 0x80, bits: 7, value: 127, hex: 'ff00' },
        { first: 0x80, bits: 7, value: 128, hex: 'ff01' },
        { first: 0x00, bits: 8, value: 254, hex: 'fe' },
        { first: 0x00, bits: 8, value: 255, hex: 'ff00' },
        { first: 0x00, bits: 8, value: 256, hex: 'ff01' },
        // A 1-bit prefix saturates immediately for value >= 1.
        { first: 0x00, bits: 1, value: 0, hex: '00' },
        { first: 0x00, bits: 1, value: 1, hex: '0100' },
        { first: 0x00, bits: 1, value: 128, hex: '017f' },
    ];
    for (const c of cases) {
        (0, node_test_1.test)(`encode ${c.value} with ${c.bits}-bit prefix => ${c.hex}`, () => {
            strict_1.default.equal((0, integer_1.encodeInteger)(c.first, c.bits, c.value).toString('hex'), c.hex);
        });
        (0, node_test_1.test)(`roundtrip ${c.value} with ${c.bits}-bit prefix`, () => {
            const encoded = (0, integer_1.encodeInteger)(c.first, c.bits, c.value);
            const decoded = (0, integer_1.decodeInteger)(encoded, 0, c.bits);
            strict_1.default.equal(decoded.value, c.value);
            strict_1.default.equal(decoded.length, encoded.length);
        });
    }
    (0, node_test_1.test)('leading flag bits outside the prefix are preserved', () => {
        // 0x80 = indexed representation marker + index 0 in a 7-bit prefix.
        strict_1.default.equal((0, integer_1.encodeInteger)(0x80, 7, 2).toString('hex'), '82');
        // 0x40 = literal incremental indexing marker.
        strict_1.default.equal((0, integer_1.encodeInteger)(0x40, 6, 1).toString('hex'), '41');
    });
    (0, node_test_1.test)('multi-byte value 2^20 round trips through a 5-bit prefix', () => {
        const value = 2 ** 20;
        const encoded = (0, integer_1.encodeInteger)(0, 5, value);
        strict_1.default.ok(encoded.length > 1);
        const decoded = (0, integer_1.decodeInteger)(encoded, 0, 5);
        strict_1.default.equal(decoded.value, value);
    });
    (0, node_test_1.test)('max safe integer encodes and decodes', () => {
        const value = Number.MAX_SAFE_INTEGER;
        const encoded = (0, integer_1.encodeInteger)(0, 8, value);
        const decoded = (0, integer_1.decodeInteger)(encoded, 0, 8);
        strict_1.default.equal(decoded.value, value);
    });
    (0, node_test_1.test)('decode at a non-zero buffer offset', () => {
        const buf = Buffer.from('aaff01', 'hex');
        const decoded = (0, integer_1.decodeInteger)(buf, 1, 7);
        strict_1.default.equal(decoded.value, 128);
        strict_1.default.equal(decoded.length, 2);
    });
});
(0, node_test_1.describe)('integer decoding errors', () => {
    (0, node_test_1.test)('truncated prefix when buffer is empty', () => {
        strict_1.default.throws(() => (0, integer_1.decodeInteger)(Buffer.alloc(0), 0, 7), {
            name: 'HpackDecodingError',
            code: 'TRUNCATED',
        });
    });
    (0, node_test_1.test)('truncated continuation with no terminator byte', () => {
        // 5-bit prefix saturated, then a 0x80 continuation that never ends.
        strict_1.default.throws(() => (0, integer_1.decodeInteger)(Buffer.from('1f80', 'hex'), 0, 5), {
            name: 'HpackDecodingError',
            code: 'TRUNCATED',
        });
    });
    (0, node_test_1.test)('integer beyond MAX_SAFE_INTEGER is rejected', () => {
        const huge = Buffer.from('ff8080808080808080808001', 'hex');
        strict_1.default.throws(() => (0, integer_1.decodeInteger)(huge, 0, 8), errors_1.HpackDecodingError);
    });
    (0, node_test_1.test)('overlong encoding is rejected', () => {
        const long = Buffer.concat([
            Buffer.from([0x1f]),
            Buffer.alloc(12, 0x80),
            Buffer.from([0x01]),
        ]);
        strict_1.default.throws(() => (0, integer_1.decodeInteger)(long, 0, 5), errors_1.HpackDecodingError);
    });
    (0, node_test_1.test)('single zero terminator after saturated prefix is legal (value 31)', () => {
        // 0x1f 0x00 is exactly what the Section 5.1 pseudocode emits for 31.
        strict_1.default.equal((0, integer_1.decodeInteger)(Buffer.from('1f00', 'hex'), 0, 5).value, 31);
        strict_1.default.equal((0, integer_1.decodeInteger)(Buffer.from('ff00', 'hex'), 0, 8).value, 255);
    });
    (0, node_test_1.test)('redundant extra zero varint digits are accepted (pseudocode permissive)', () => {
        // 1f 80 00 decodes to 31 although 1f 00 is the minimal encoding;
        // RFC 7541 does not require decoders to reject non-minimal forms.
        strict_1.default.equal((0, integer_1.decodeInteger)(Buffer.from('1f8000', 'hex'), 0, 5).value, 31);
    });
    (0, node_test_1.test)('interior zero-payload continuation byte is legal (159 case)', () => {
        const encoded = (0, integer_1.encodeInteger)(0, 5, 159);
        strict_1.default.equal(encoded.toString('hex'), '1f8001');
        strict_1.default.equal((0, integer_1.decodeInteger)(encoded, 0, 5).value, 159);
    });
    (0, node_test_1.test)('invalid prefix width is rejected', () => {
        strict_1.default.throws(() => (0, integer_1.encodeInteger)(0, 0, 1), errors_1.HpackEncodingError);
        strict_1.default.throws(() => (0, integer_1.encodeInteger)(0, 9, 1), errors_1.HpackEncodingError);
        strict_1.default.throws(() => (0, integer_1.decodeInteger)(Buffer.from([0]), 0, 0), errors_1.HpackDecodingError);
    });
    (0, node_test_1.test)('negative and non-integer values are rejected by encoder', () => {
        strict_1.default.throws(() => (0, integer_1.encodeInteger)(0, 5, -1), errors_1.HpackEncodingError);
        strict_1.default.throws(() => (0, integer_1.encodeInteger)(0, 5, 1.5), errors_1.HpackEncodingError);
        strict_1.default.throws(() => (0, integer_1.encodeInteger)(0, 5, Number.NaN), errors_1.HpackEncodingError);
    });
});
