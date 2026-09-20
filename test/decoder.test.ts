import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {HpackDecoder} from '../src/decoder';
import {
  HpackDecodingError,
  HuffmanUnsupportedError,
} from '../src/errors';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('RFC 7541 Appendix C.3 golden vectors (no Huffman)', () => {
  test('C.3.1 first request indexes :authority into the dynamic table', () => {
    const dec = new HpackDecoder();
    const block = hex('8286 8441 0f77 7777 2e65 7861 6d70 6c65 2e63 6f6d');
    const headers = dec.decode(block);
    assert.deepEqual(
      headers.map(h => [h.name, h.value]),
      [
        [':method', 'GET'],
        [':scheme', 'http'],
        [':path', '/'],
        [':authority', 'www.example.com'],
      ]
    );
    const snap = dec.snapshot();
    assert.equal(snap.entries.length, 1);
    assert.equal(snap.entries[0]!.name, ':authority');
    assert.equal(snap.entries[0]!.value, 'www.example.com');
    assert.equal(snap.entries[0]!.size, 57);
    assert.equal(snap.size, 57);
  });

  test('C.3.2 second request reuses dynamic index 62', () => {
    const dec = new HpackDecoder();
    dec.decode(hex('8286 8441 0f77 7777 2e65 7861 6d70 6c65 2e63 6f6d'));

    const headers = dec.decode(hex('8286 84be 5808 6e6f 2d63 6163 6865'));
    assert.deepEqual(
      headers.map(h => [h.name, h.value]),
      [
        [':method', 'GET'],
        [':scheme', 'http'],
        [':path', '/'],
        [':authority', 'www.example.com'],
        ['cache-control', 'no-cache'],
      ]
    );
    const snap = dec.snapshot();
    assert.deepEqual(
      snap.entries.map(e => e.name),
      ['cache-control', ':authority']
    );
    assert.equal(snap.size, 110);
  });

  test('C.3.3 third request uses dynamic indexes 62/63 and a literal name', () => {
    const dec = new HpackDecoder();
    dec.decode(hex('8286 8441 0f77 7777 2e65 7861 6d70 6c65 2e63 6f6d'));
    dec.decode(hex('8286 84be 5808 6e6f 2d63 6163 6865'));

    const headers = dec.decode(
      hex('8287 85bf 400a 6375 7374 6f6d 2d6b 6579 0c63 7573 746f 6d2d 7661 6c75 65')
    );
    assert.deepEqual(
      headers.map(h => [h.name, h.value]),
      [
        [':method', 'GET'],
        [':scheme', 'https'],
        [':path', '/index.html'],
        [':authority', 'www.example.com'],
        ['custom-key', 'custom-value'],
      ]
    );
    const snap = dec.snapshot();
    assert.deepEqual(
      snap.entries.map(e => e.name),
      ['custom-key', 'cache-control', ':authority']
    );
    assert.equal(snap.size, 164);
    assert.equal(snap.entries[0]!.size, 54);
  });
});

describe('literal representations', () => {
  test('literal without indexing (0000) does not touch the dynamic table', () => {
    const dec = new HpackDecoder();
    // 00 name idx 4 (:path), value "x"
    const block = hex('0401 78');
    const [h] = dec.decode(block);
    assert.equal(h!.name, ':path');
    assert.equal(h!.value, 'x');
    assert.equal(h!.indexing, 'none');
    assert.equal(dec.tableLength, 0);
  });

  test('literal never indexed (0001) is reported and never stored', () => {
    const dec = new HpackDecoder();
    // 14 => 0001 0100: never-indexed, name index 4 (:path)
    const block = hex('1401 78');
    const [h] = dec.decode(block);
    assert.equal(h!.name, ':path');
    assert.equal(h!.value, 'x');
    assert.equal(h!.indexing, 'never');
    assert.equal(dec.tableLength, 0);
  });

  test('literal with literal name (index 0) and value', () => {
    const dec = new HpackDecoder();
    // 40: incremental indexing, literal name; name "k", value "v"
    const block = hex('4001 6b 01 76');
    const [h] = dec.decode(block);
    assert.equal(h!.name, 'k');
    assert.equal(h!.value, 'v');
    assert.equal(h!.indexing, 'indexed');
    assert.equal(dec.tableLength, 1);
  });

  test('empty block decodes to an empty list without changing state', () => {
    const dec = new HpackDecoder();
    assert.deepEqual(dec.decode(Buffer.alloc(0)), []);
  });
});

describe('indexed representation errors', () => {
  test('index 0 is invalid', () => {
    const dec = new HpackDecoder();
    assert.throws(() => dec.decode(hex('80')), {code: 'INDEX_OUT_OF_RANGE'});
  });

  test('index past static+dynamic table is out of range', () => {
    const dec = new HpackDecoder();
    // Static table ends at 61; nothing dynamic exists.
    assert.throws(() => dec.decode(hex('be')), {code: 'INDEX_OUT_OF_RANGE'}); // 62
    assert.throws(() => dec.decode(hex('ff00')), {code: 'INDEX_OUT_OF_RANGE'}); // 127
  });

  test('dynamic index becomes valid after insertion, then invalid after eviction', () => {
    const dec = new HpackDecoder({initialMaxTableSize: 64});
    // Insert a literal indexed entry (name "a" value "b", size 34).
    dec.decode(hex('40 0161 0162'));
    assert.doesNotThrow(() => dec.decode(hex('be'))); // dynamic index 62 -> a: b

    // Shrink to 0, entry evicted; 62 is now out of range.
    assert.throws(() => dec.decode(hex('20be')), {code: 'INDEX_OUT_OF_RANGE'});
  });
});

describe('dynamic table size updates', () => {
  test('prefix update evicts before subsequent fields are read', () => {
    const dec = new HpackDecoder({initialMaxTableSize: 4096});
    dec.decode(hex('40 0161 0162')); // inserts a: b (34)
    assert.equal(dec.tableLength, 1);

    // 20 = size update to 0, then a static indexed field.
    const headers = dec.decode(hex('20 82'));
    assert.equal(headers.length, 1);
    assert.equal(dec.tableLength, 0);
    assert.equal(dec.maxTableSize, 0);
  });

  test('consecutive size updates in one block are applied in order', () => {
    const dec = new HpackDecoder({initialMaxTableSize: 4096});
    dec.decode(hex('40 0161 0162')); // a: b (34)
    dec.decode(hex('40 0163 0164')); // c: d (34), table 68

    // update 0 (evict all), then update 100 (0x3f saturates the 5-bit
    // prefix, 100-31 = 69 = 0x45), then a static indexed field.
    dec.decode(hex('20 3f45 82'));
    assert.equal(dec.tableLength, 0);
    assert.equal(dec.maxTableSize, 100);
  });

  test('size update after a header field is a decoding error', () => {
    const dec = new HpackDecoder();
    // 82 (indexed field) then 20 size update: illegal ordering.
    assert.throws(() => dec.decode(hex('82 20')), HpackDecodingError);
  });

  test('update above the negotiated limit (257) is rejected', () => {
    const dec = new HpackDecoder({
      initialMaxTableSize: 128,
      maxTableSizeLimit: 256,
    });
    // 0x3f saturates the 5-bit prefix (31), continuation 257-31 = 226 -> 0xe2 0x01.
    assert.throws(() => dec.decode(hex('3fe201')), HpackDecodingError);
    assert.equal(dec.maxTableSize, 128);
  });
});

describe('Huffman rejection on decode', () => {
  test('H bit on a value throws HuffmanUnsupportedError and rolls state back', () => {
    const dec = new HpackDecoder();
    // 44: incremental indexing, name index 4 (:path); value: 0x83 H=1 len 3.
    assert.throws(
      () => dec.decode(hex('44 83 aabbcc')),
      HuffmanUnsupportedError
    );
    assert.equal(dec.tableLength, 0);
  });

  test('H bit on a literal name is rejected', () => {
    const dec = new HpackDecoder();
    // 40: incremental literal; name H=1 len 1; then irrelevant.
    assert.throws(
      () => dec.decode(hex('40 81 aa')),
      HuffmanUnsupportedError
    );
  });
});

describe('atomic rollback of a failed header block', () => {
  test('partial insertions within the failed block are undone', () => {
    const dec = new HpackDecoder();
    dec.decode(hex('40 0161 0162')); // a: b survives from a previous block
    assert.equal(dec.tableLength, 1);

    // This block: insert c:d successfully... then reference index 201
    // (out of range) at the end. Neither insertion must survive.
    const bad = hex('40 0163 0164 ff4a'); // ff 4a => index 201
    assert.throws(() => dec.decode(bad), {code: 'INDEX_OUT_OF_RANGE'});

    const snap = dec.snapshot();
    assert.equal(snap.entries.length, 1);
    assert.equal(snap.entries[0]!.name, 'a');
    // Capacity changes inside the failed block must also be undone.
    assert.equal(dec.maxTableSize, 4096);
  });

  test('size updates followed by a later failure are rolled back', () => {
    const dec = new HpackDecoder();
    dec.decode(hex('40 0161 0162'));
    // update 0 evicts a:b, then bad index -> whole block rolls back.
    assert.throws(
      () => dec.decode(hex('20 ff4a')),
      {code: 'INDEX_OUT_OF_RANGE'}
    );
    assert.equal(dec.tableLength, 1);
    assert.equal(dec.maxTableSize, 4096);
  });

  test('truncated block leaves the table untouched', () => {
    const dec = new HpackDecoder();
    dec.decode(hex('40 0161 0162'));
    assert.throws(() => dec.decode(hex('40 01 63 05 78')), {code: 'TRUNCATED'});
    assert.equal(dec.tableLength, 1);
    assert.equal(dec.snapshot().entries[0]!.name, 'a');
  });

  test('out-of-range name index in a literal rolls back earlier insertions', () => {
    const dec = new HpackDecoder();
    dec.decode(hex('40 0161 0162')); // a: b survives from block 1
    // Insert c:d, then an incremental literal whose NAME index is 200
    // (6-bit prefix saturated: 0x7f + 200-63 = 137 -> 0x89 0x01), then a
    // value byte that never gets read.
    const bad = hex('40 0163 0164 7f8901 01 78');
    assert.throws(() => dec.decode(bad), {code: 'INDEX_OUT_OF_RANGE'});
    const snap = dec.snapshot();
    assert.equal(snap.entries.length, 1);
    assert.equal(snap.entries[0]!.name, 'a');
  });

  test('a successful later block after a failure reuses prior state', () => {
    const dec = new HpackDecoder();
    assert.throws(() => dec.decode(hex('ff4a')), HpackDecodingError);
    // Static indexed field still decodes fine.
    const headers = dec.decode(hex('82'));
    assert.equal(headers[0]!.name, ':method');
  });
});

describe('multi-connection isolation', () => {
  test('separate decoder instances do not share dynamic tables', () => {
    const a = new HpackDecoder();
    const b = new HpackDecoder();
    a.decode(hex('40 0161 0162'));
    assert.equal(a.tableLength, 1);
    assert.equal(b.tableLength, 0);

    // b has no dynamic entry: index 62 must be out of range there.
    assert.throws(() => b.decode(hex('be')), {code: 'INDEX_OUT_OF_RANGE'});
    assert.doesNotThrow(() => a.decode(hex('be')));
  });
});
