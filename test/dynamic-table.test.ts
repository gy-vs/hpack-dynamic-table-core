import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {DynamicTable, entrySize} from '../src/dynamic-table';
import {HpackDecodingError} from '../src/errors';

describe('entry sizing (RFC 7541, Section 4.1)', () => {
  test('size is name bytes + value bytes + 32', () => {
    assert.equal(entrySize('name', 'value'), 4 + 5 + 32);
    assert.equal(entrySize('', ''), 32);
  });

  test('utf-8 multibyte names/values are measured in bytes', () => {
    // "中" is 3 bytes.
    assert.equal(entrySize('中', ''), 3 + 0 + 32);
  });
});

describe('insertion and FIFO eviction (Section 4.4)', () => {
  test('newest entry is at dynamic index 1', () => {
    const t = new DynamicTable(256);
    t.add('a', '1');
    t.add('b', '2');
    assert.equal(t.get(1)!.name, 'b');
    assert.equal(t.get(2)!.name, 'a');
  });

  test('size and length track insertions', () => {
    const t = new DynamicTable(256);
    t.add('a', '1');
    t.add('b', '2');
    assert.equal(t.length, 2);
    assert.equal(t.size, entrySize('a', '1') + entrySize('b', '2'));
  });

  test('oldest entries are evicted first when capacity is exceeded', () => {
    const t = new DynamicTable(entrySize('a', '1') * 3);
    t.add('a', '1'); // size s
    t.add('b', '2'); // 2s
    t.add('c', '3'); // 3s: exactly full

    // Inserting d must evict a (oldest); b and c survive with d.
    t.add('d', '4');
    assert.equal(t.length, 3);
    assert.equal(t.get(1)!.name, 'd');
    assert.equal(t.get(2)!.name, 'c');
    assert.equal(t.get(3)!.name, 'b');
    assert.equal(t.get(4), undefined);
  });

  test('a single oversized entry empties the table and is not inserted', () => {
    const s = entrySize('small', 'x');
    const t = new DynamicTable(s * 2);
    t.add('small', 'x');
    t.add('small', 'x');
    assert.equal(t.length, 2);

    // Big value can never fit: table drains, big entry is not stored.
    const big = 'y'.repeat(s * 2);
    t.add('big', big);
    assert.equal(t.length, 0);
    assert.equal(t.size, 0);
  });

  test('get() out of range returns undefined', () => {
    const t = new DynamicTable(256);
    t.add('a', '1');
    assert.equal(t.get(0), undefined);
    assert.equal(t.get(2), undefined);
  });
});

describe('capacity updates (Section 4.2)', () => {
  test('shrinking evicts oldest entries until everything fits', () => {
    const t = new DynamicTable(512);
    t.add('a', '1');
    const s = entrySize('a', '1');
    t.add('b', '2');
    t.add('c', '3');

    t.setMaxSize(s); // only the single newest entry can remain
    assert.equal(t.length, 1);
    assert.equal(t.get(1)!.name, 'c');
    assert.equal(t.size, s);
  });

  test('zero capacity empties the table', () => {
    const t = new DynamicTable(256);
    t.add('a', '1');
    t.setMaxSize(0);
    assert.equal(t.length, 0);
    assert.equal(t.size, 0);
    assert.equal(t.maxSize, 0);

    // Nothing can be added at capacity zero.
    t.add('a', '1');
    assert.equal(t.length, 0);
  });

  test('growing capacity keeps all existing entries', () => {
    const t = new DynamicTable(64);
    t.add('a', '1');
    t.setMaxSize(256);
    assert.equal(t.length, 1);
    assert.equal(t.get(1)!.name, 'a');
    assert.equal(t.maxSize, 256);
  });

  test('consecutive size updates each take effect immediately', () => {
    const t = new DynamicTable(512);
    t.add('a', '1');
    const s = entrySize('a', '1');
    t.add('b', '2');
    t.setMaxSize(s); // leaves only b
    assert.equal(t.length, 1);
    t.setMaxSize(0); // empties
    assert.equal(t.length, 0);
    t.setMaxSize(512); // large again, nothing restored
    assert.equal(t.length, 0);
    t.add('c', '3');
    assert.equal(t.length, 1);
  });

  test('update beyond the protocol maximum is rejected and leaves state intact', () => {
    const t = new DynamicTable(128, 256);
    t.add('a', '1');
    assert.throws(
      () => t.setMaxSize(257),
      (err: unknown) => err instanceof HpackDecodingError
    );
    assert.equal(t.maxSize, 128);
    assert.equal(t.length, 1);
  });

  test('negative and non-integer sizes are rejected', () => {
    const t = new DynamicTable(128);
    assert.throws(() => t.setMaxSize(-1), HpackDecodingError);
    assert.throws(() => t.setMaxSize(1.5), HpackDecodingError);
  });

  test('constructor rejects an initial size over the limit', () => {
    assert.throws(() => new DynamicTable(257, 256), HpackDecodingError);
  });
});

describe('checkpoint / rollback', () => {
  test('restore() reinstates entries, size and capacity', () => {
    const t = new DynamicTable(256);
    t.add('a', '1');
    const cp = t.checkpoint();

    t.add('b', '2');
    t.setMaxSize(0);
    assert.equal(t.length, 0);
    assert.equal(t.maxSize, 0);

    t.restore(cp);
    assert.equal(t.length, 1);
    assert.equal(t.get(1)!.name, 'a');
    assert.equal(t.maxSize, 256);
    assert.equal(t.size, entrySize('a', '1'));
  });
});

describe('snapshot isolation', () => {
  test('snapshot reflects current contents newest first', () => {
    const t = new DynamicTable(256);
    t.add('a', '1');
    t.add('b', '2');
    const snap = t.snapshot();
    assert.deepEqual(
      snap.entries.map(e => [e.name, e.value]),
      [
        ['b', '2'],
        ['a', '1'],
      ]
    );
    assert.equal(snap.maxSize, 256);
  });

  test('mutating the snapshot array cannot alter the table', () => {
    const t = new DynamicTable(256);
    t.add('a', '1');
    const snap = t.snapshot() as unknown as {
      entries: unknown[];
    };
    assert.throws(() => {
      'use strict';
      snap.entries.push({name: 'evil', value: 'x', size: 1});
    }, TypeError);
    assert.equal(t.length, 1);
  });

  test('mutating a snapshot entry object is frozen', () => {
    const t = new DynamicTable(256);
    t.add('a', '1');
    const entry = t.snapshot().entries[0] as unknown as {name: string};
    assert.throws(() => {
      'use strict';
      entry.name = 'evil';
    }, TypeError);
    assert.equal(t.get(1)!.name, 'a');
  });

  test('snapshots are independent of later table changes', () => {
    const t = new DynamicTable(256);
    t.add('a', '1');
    const before = t.snapshot();
    t.add('b', '2');
    t.setMaxSize(0);
    assert.equal(before.entries.length, 1);
    assert.equal(before.entries[0]!.name, 'a');
  });
});
