import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeString, encodeString} from '../src/string-literal';
import {HuffmanUnsupportedError, HpackDecodingError} from '../src/errors';

describe('raw string literals (H=0)', () => {
  test('empty string', () => {
    const enc = encodeString('');
    assert.deepEqual([...enc], [0x00]);
    const dec = decodeString(enc, 0);
    assert.equal(dec.value, '');
    assert.equal(dec.length, 1);
  });

  test('short ascii string with length prefix', () => {
    const enc = encodeString('www.example.com');
    assert.equal(enc.toString('hex'), '0f7777772e6578616d706c652e636f6d');
    const dec = decodeString(enc, 0);
    assert.equal(dec.value, 'www.example.com');
    assert.equal(dec.length, enc.length);
  });

  test('127/128 byte lengths exercise the 7-bit prefix continuation', () => {
    for (const n of [127, 128, 300]) {
      const value = 'a'.repeat(n);
      const enc = encodeString(value);
      // First byte saturated, continuation follows.
      assert.equal(enc[0], 0x7f);
      const dec = decodeString(enc, 0);
      assert.equal(dec.value, value);
      assert.equal(dec.length, enc.length);
    }
  });

  test('utf-8 multibyte characters count in bytes not code points', () => {
    // U+4E2D encodes to 3 UTF-8 octets; entry/string length must be 3.
    const enc = encodeString('中');
    assert.equal(enc[0], 3);
    assert.equal(enc.toString('hex'), '03e4b8ad');
    assert.equal(decodeString(enc, 0).value, '中');
  });

  test('Buffer input is written verbatim', () => {
    const raw = Buffer.from([0x00, 0x01, 0xff]);
    const enc = encodeString(raw);
    assert.deepEqual([...enc], [0x03, 0x00, 0x01, 0xff]);
  });
});

describe('string decoding errors', () => {
  test('Huffman flag (H=1) throws explicit unsupported error', () => {
    // Length 3 with H bit set, then three payload bytes.
    const block = Buffer.from('83aabbcc', 'hex');
    assert.throws(() => decodeString(block, 0), (err: unknown) => {
      assert.ok(err instanceof HuffmanUnsupportedError);
      assert.equal((err as HuffmanUnsupportedError).code, 'HUFFMAN_UNSUPPORTED');
      assert.match((err as Error).message, /huffman/i);
      return true;
    });
  });

  test('truncated string header', () => {
    assert.throws(() => decodeString(Buffer.alloc(0), 0), {code: 'TRUNCATED'});
  });

  test('truncated multi-byte length', () => {
    assert.throws(() => decodeString(Buffer.from([0x7f, 0x80]), 0), {
      code: 'TRUNCATED',
    });
  });

  test('declared length exceeds remaining bytes', () => {
    // Says 5 bytes, only provides 2.
    const block = Buffer.from('056162', 'hex');
    assert.throws(() => decodeString(block, 0), {code: 'TRUNCATED'});
  });

  test('huffman length is validated before the H-bit check', () => {
    // H set, length 10, no payload: truncated rather than Huffman error.
    assert.throws(() => decodeString(Buffer.from([0x8a]), 0), HpackDecodingError);
  });
});
