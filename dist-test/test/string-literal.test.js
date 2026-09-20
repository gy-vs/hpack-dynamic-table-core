"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const string_literal_1 = require("../src/string-literal");
const errors_1 = require("../src/errors");
(0, node_test_1.describe)('raw string literals (H=0)', () => {
    (0, node_test_1.test)('empty string', () => {
        const enc = (0, string_literal_1.encodeString)('');
        strict_1.default.deepEqual([...enc], [0x00]);
        const dec = (0, string_literal_1.decodeString)(enc, 0);
        strict_1.default.equal(dec.value, '');
        strict_1.default.equal(dec.length, 1);
    });
    (0, node_test_1.test)('short ascii string with length prefix', () => {
        const enc = (0, string_literal_1.encodeString)('www.example.com');
        strict_1.default.equal(enc.toString('hex'), '0f7777772e6578616d706c652e636f6d');
        const dec = (0, string_literal_1.decodeString)(enc, 0);
        strict_1.default.equal(dec.value, 'www.example.com');
        strict_1.default.equal(dec.length, enc.length);
    });
    (0, node_test_1.test)('127/128 byte lengths exercise the 7-bit prefix continuation', () => {
        for (const n of [127, 128, 300]) {
            const value = 'a'.repeat(n);
            const enc = (0, string_literal_1.encodeString)(value);
            // First byte saturated, continuation follows.
            strict_1.default.equal(enc[0], 0x7f);
            const dec = (0, string_literal_1.decodeString)(enc, 0);
            strict_1.default.equal(dec.value, value);
            strict_1.default.equal(dec.length, enc.length);
        }
    });
    (0, node_test_1.test)('utf-8 multibyte characters count in bytes not code points', () => {
        // U+4E2D encodes to 3 UTF-8 octets; entry/string length must be 3.
        const enc = (0, string_literal_1.encodeString)('中');
        strict_1.default.equal(enc[0], 3);
        strict_1.default.equal(enc.toString('hex'), '03e4b8ad');
        strict_1.default.equal((0, string_literal_1.decodeString)(enc, 0).value, '中');
    });
    (0, node_test_1.test)('Buffer input is written verbatim', () => {
        const raw = Buffer.from([0x00, 0x01, 0xff]);
        const enc = (0, string_literal_1.encodeString)(raw);
        strict_1.default.deepEqual([...enc], [0x03, 0x00, 0x01, 0xff]);
    });
});
(0, node_test_1.describe)('string decoding errors', () => {
    (0, node_test_1.test)('Huffman flag (H=1) throws explicit unsupported error', () => {
        // Length 3 with H bit set, then three payload bytes.
        const block = Buffer.from('83aabbcc', 'hex');
        strict_1.default.throws(() => (0, string_literal_1.decodeString)(block, 0), (err) => {
            strict_1.default.ok(err instanceof errors_1.HuffmanUnsupportedError);
            strict_1.default.equal(err.code, 'HUFFMAN_UNSUPPORTED');
            strict_1.default.match(err.message, /huffman/i);
            return true;
        });
    });
    (0, node_test_1.test)('truncated string header', () => {
        strict_1.default.throws(() => (0, string_literal_1.decodeString)(Buffer.alloc(0), 0), { code: 'TRUNCATED' });
    });
    (0, node_test_1.test)('truncated multi-byte length', () => {
        strict_1.default.throws(() => (0, string_literal_1.decodeString)(Buffer.from([0x7f, 0x80]), 0), {
            code: 'TRUNCATED',
        });
    });
    (0, node_test_1.test)('declared length exceeds remaining bytes', () => {
        // Says 5 bytes, only provides 2.
        const block = Buffer.from('056162', 'hex');
        strict_1.default.throws(() => (0, string_literal_1.decodeString)(block, 0), { code: 'TRUNCATED' });
    });
    (0, node_test_1.test)('huffman length is validated before the H-bit check', () => {
        // H set, length 10, no payload: truncated rather than Huffman error.
        strict_1.default.throws(() => (0, string_literal_1.decodeString)(Buffer.from([0x8a]), 0), errors_1.HpackDecodingError);
    });
});
