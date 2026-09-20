import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {HpackEncoder} from '../src/encoder';
import {HpackDecoder} from '../src/decoder';
import {
  HpackEncodingError,
  HuffmanUnsupportedError,
} from '../src/errors';

describe('encoder static indexing', () => {
  test('exact static entries are emitted as indexed fields', () => {
    const enc = new HpackEncoder();
    const out = enc.encode([
      {name: ':method', value: 'GET'},
      {name: ':scheme', value: 'http'},
      {name: ':path', value: '/'},
      {name: ':status', value: '200'},
    ]);
    assert.equal(out.toString('hex'), '82868488');
    assert.equal(enc.tableLength, 0);
  });

  test('name-only static match uses literal with that name reference', () => {
    const enc = new HpackEncoder();
    // :path /custom is not static; name is static index 4, literal value.
    const out = enc.encode([{name: ':path', value: '/custom'}]);
    assert.equal(out.toString('hex'), '44072f637573746f6d');
  });

  test('RFC C.3.1 first request bytes match (authority indexed)', () => {
    const enc = new HpackEncoder();
    const out = enc.encode([
      {name: ':method', value: 'GET'},
      {name: ':scheme', value: 'http'},
      {name: ':path', value: '/'},
      {name: ':authority', value: 'www.example.com'},
    ]);
    assert.equal(
      out.toString('hex'),
      '828684410f7777772e6578616d706c652e636f6d'
    );
  });

  test('C.3.2 exact dynamic value is reused as indexed field 62', () => {
    const enc = new HpackEncoder();
    enc.encode([
      {name: ':method', value: 'GET'},
      {name: ':scheme', value: 'http'},
      {name: ':path', value: '/'},
      {name: ':authority', value: 'www.example.com'},
    ]);

    const out = enc.encode([
      {name: ':method', value: 'GET'},
      {name: ':scheme', value: 'http'},
      {name: ':path', value: '/'},
      {name: ':authority', value: 'www.example.com'},
      {name: 'cache-control', value: 'no-cache'},
    ]);
    // 82 86 84 be (dynamic 62) 58 08 no-cache
    assert.equal(out.toString('hex'), '828684be58086e6f2d6361636865');
  });
});

describe('literal without / never indexing', () => {
  test('indexing "none" uses 0000xxxx and never enters the table', () => {
    const enc = new HpackEncoder();
    const out = enc.encode([
      {name: ':path', value: '/secret', indexing: 'none'},
    ]);
    // 04 (name idx 4) + len 7 + /secret
    assert.equal(out.toString('hex'), '04072f736563726574');
    assert.equal(enc.tableLength, 0);
  });

  test('indexing "never" uses 0001xxxx and never enters the table', () => {
    const enc = new HpackEncoder();
    const out = enc.encode([
      {name: 'authorization', value: 'bearer token', indexing: 'never'},
    ]);
    // authorization is static index 23, which saturates the 4-bit prefix
    // (15): 0001 1111 then 23-15 = 8 as the first continuation byte.
    assert.equal(out.subarray(0, 2).toString('hex'), '1f08');
    assert.equal(enc.tableLength, 0);
  });

  test('a never-indexed field that previously got indexed is still not referenced on repeat', () => {
    // Exact-match references from a normal insertion still encode fine,
    // but a field explicitly marked never must use the literal form.
    const enc = new HpackEncoder();
    enc.encode([{name: 'x-secret', value: 's', indexing: 'never'}]);
    const out = enc.encode([
      {name: 'x-secret', value: 's', indexing: 'never'},
    ]);
    // Literal name (10 00) + "x-secret" + value "s".
    assert.equal(out.subarray(0, 1).toString('hex'), '10');
    assert.equal(enc.tableLength, 0);
  });

  test('literal name fallback with 4-bit prefix (no static/dynamic name)', () => {
    const enc = new HpackEncoder();
    const out = enc.encode([
      {name: 'x-custom', value: 'v', indexing: 'none'},
    ]);
    assert.equal(out.toString('hex'), '0008782d637573746f6d0176');
  });
});

describe('encoder dynamic table eviction', () => {
  test('insertion evicts oldest entries to respect capacity', () => {
    const enc = new HpackEncoder({initialMaxTableSize: 40});
    // name "a"/value "b" entry size = 1+1+32 = 34: only one fits.
    enc.encode([{name: 'a', value: '1'}]);
    enc.encode([{name: 'a', value: '2'}]);
    const snap = enc.snapshot();
    assert.equal(snap.entries.length, 1);
    assert.equal(snap.entries[0]!.value, '2');
  });
});

describe('encoder table size updates', () => {
  test('queued update is prefixed to the next block once', () => {
    const enc = new HpackEncoder();
    enc.setTableSizeUpdate(0);
    const out = enc.encode([{name: ':method', value: 'GET'}]);
    assert.equal(out.subarray(0, 1).toString('hex'), '20');
    assert.equal(out.toString('hex'), '2082');

    // Not re-emitted on the following block.
    const next = enc.encode([{name: ':method', value: 'GET'}]);
    assert.equal(next.toString('hex'), '82');
  });

  test('multiple queued updates appear consecutively and evict in order', () => {
    const enc = new HpackEncoder();
    enc.encode([{name: 'a', value: '1'}]); // 34 bytes
    enc.setTableSizeUpdate(0); // evicts
    enc.setTableSizeUpdate(256); // regrows
    const out = enc.encode([{name: ':method', value: 'GET'}]);
    // 20 (size 0) then 3f 02 (31+2=33)? 256 => 31 + 225 = 0x3f 0xe1 0x01
    assert.equal(out.subarray(0, 1).toString('hex'), '20');
    assert.equal(out.subarray(1, 4).toString('hex'), '3fe101');
    assert.equal(enc.tableLength, 0);
    assert.equal(enc.maxTableSize, 256);
  });

  test('per-call option updates are emitted on this block only', () => {
    const enc = new HpackEncoder();
    const first = enc.encode([{name: ':method', value: 'GET'}], {
      tableSizeUpdates: [0],
    });
    assert.equal(first.toString('hex'), '2082');
    const second = enc.encode([{name: ':method', value: 'GET'}]);
    assert.equal(second.toString('hex'), '82');
  });

  test('update beyond the negotiated maximum is rejected', () => {
    const enc = new HpackEncoder({
      initialMaxTableSize: 128,
      maxTableSizeLimit: 256,
    });
    assert.throws(() => enc.setTableSizeUpdate(257), HpackEncodingError);
    assert.equal(enc.maxTableSize, 128);
  });
});

describe('encoder validation and Huffman opt-in', () => {
  test('empty name and non-string value are rejected', () => {
    const enc = new HpackEncoder();
    assert.throws(() => enc.encode([{name: '', value: 'x'}]), HpackEncodingError);
    assert.throws(
      () => enc.encode([{name: 'x', value: 42 as unknown as string}]),
      HpackEncodingError
    );
  });

  test('unknown indexing mode is rejected', () => {
    const enc = new HpackEncoder();
    assert.throws(
      () =>
        enc.encode([
          {name: 'x', value: 'y', indexing: 'bogus' as unknown as 'never'},
        ]),
      HpackEncodingError
    );
  });

  test('requesting Huffman coding throws the explicit unsupported error', () => {
    const enc = new HpackEncoder();
    assert.throws(() => enc.setHuffmanEnabled(true), HuffmanUnsupportedError);
    assert.doesNotThrow(() => enc.setHuffmanEnabled(false));
  });

  test('a failed encode leaves table state and queued updates untouched', () => {
    const enc = new HpackEncoder();
    enc.encode([{name: 'keep', value: '1'}]);
    enc.setTableSizeUpdate(0); // queued; capacity already applied (evicts)

    assert.throws(
      () =>
        enc.encode([
          {name: 'good', value: 'x'},
          {name: '', value: 'invalid'},
        ]),
      HpackEncodingError
    );

    // No half-encoded entry survived...
    assert.equal(enc.tableLength, 0);
    // ...and the queued update is still armed for the next good block.
    const next = enc.encode([{name: ':method', value: 'GET'}]);
    assert.equal(next.toString('hex'), '2082');
    // Only emitted once.
    assert.equal(
      enc.encode([{name: ':method', value: 'GET'}]).toString('hex'),
      '82'
    );
  });

  test('an oversized per-call size update aborts without partial effects', () => {
    const enc = new HpackEncoder({
      initialMaxTableSize: 128,
      maxTableSizeLimit: 256,
    });
    enc.encode([{name: 'keep', value: '1'}]);
    assert.throws(
      () => enc.encode([{name: 'a', value: 'b'}], {tableSizeUpdates: [257]}),
      HpackEncodingError
    );
    assert.equal(enc.maxTableSize, 128);
    assert.equal(enc.tableLength, 1);
    assert.equal(enc.snapshot().entries[0]!.name, 'keep');
  });
});

describe('encoder/decoder cross-validation', () => {
  test('everything the encoder emits decodes back to the same headers', () => {
    const enc = new HpackEncoder();
    const dec = new HpackDecoder();
    const blocks: Array<Array<{name: string; value: string; indexing?: 'indexed' | 'none' | 'never'}>> = [
      [
        {name: ':method', value: 'GET'},
        {name: ':scheme', value: 'https'},
        {name: ':path', value: '/'},
        {name: ':authority', value: 'example.com'},
        {name: 'authorization', value: 'Bearer abc', indexing: 'never'},
      ],
      [
        {name: ':method', value: 'GET'},
        {name: ':authority', value: 'example.com'}, // dynamic exact match
        {name: 'x-trace', value: '1234567890', indexing: 'none'},
      ],
      [
        {name: 'custom-utf8', value: 'héllo-世界'},
        {name: 'cookie', value: 'a=b; c=d', indexing: 'never'},
      ],
    ];

    for (const block of blocks) {
      const wire = enc.encode(block);
      const decoded = dec.decode(wire);
      assert.equal(decoded.length, block.length);
      for (let i = 0; i < block.length; i++) {
        assert.equal(decoded[i]!.name, block[i]!.name);
        assert.equal(decoded[i]!.value, block[i]!.value);
        assert.equal(decoded[i]!.indexing, block[i]!.indexing ?? 'indexed');
      }
      // Encoder and decoder dynamic tables must stay in lockstep.
      assert.deepEqual(
        enc.snapshot().entries.map(e => [e.name, e.value, e.size]),
        dec.snapshot().entries.map(e => [e.name, e.value, e.size])
      );
      assert.equal(enc.tableSize, dec.tableSize);
    }
  });

  test('eviction order stays synchronized when capacity is tight', () => {
    const enc = new HpackEncoder({initialMaxTableSize: 70});
    const dec = new HpackDecoder({initialMaxTableSize: 70});

    for (let i = 0; i < 5; i++) {
      const headers = [
        {name: `k${i}`, value: `v${i}-xxxxxxxxxxxx`},
      ];
      const wire = enc.encode(headers);
      const decoded = dec.decode(wire);
      assert.equal(decoded[0]!.name, `k${i}`);
      assert.deepEqual(
        enc.snapshot().entries.map(e => e.name),
        dec.snapshot().entries.map(e => e.name)
      );
    }
  });

  test('encoder instance isolation: independent dynamic tables', () => {
    const a = new HpackEncoder();
    const b = new HpackEncoder();
    a.encode([{name: 'x-a', value: '1'}]);
    assert.equal(a.tableLength, 1);
    assert.equal(b.tableLength, 0);

    // Each encoder feeds its own decoder; a dynamic reference emitted by
    // `a` must not be resolvable in a decoder belonging to another
    // connection.
    const pairedA = new HpackDecoder();
    const pairedB = new HpackDecoder();

    // `a` already holds x-a, so every later emission is the bare dynamic
    // reference 0xbe (index 62).
    const referenceWire = a.encode([{name: 'x-a', value: '1'}]);
    assert.equal(referenceWire.toString('hex'), 'be');

    // A foreign decoder with no matching state rejects that reference.
    assert.throws(() => pairedB.decode(referenceWire), {
      code: 'INDEX_OUT_OF_RANGE',
    });

    // A separate connection that independently built the same state
    // accepts the reference and does not duplicate the entry.
    const seeder = new HpackEncoder();
    pairedA.decode(seeder.encode([{name: 'x-a', value: '1'}]));
    assert.doesNotThrow(() => pairedA.decode(Buffer.from('be', 'hex')));
    assert.equal(pairedA.tableLength, 1);
  });
});
