"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const dynamic_table_1 = require("../src/dynamic-table");
const errors_1 = require("../src/errors");
(0, node_test_1.describe)('entry sizing (RFC 7541, Section 4.1)', () => {
    (0, node_test_1.test)('size is name bytes + value bytes + 32', () => {
        strict_1.default.equal((0, dynamic_table_1.entrySize)('name', 'value'), 4 + 5 + 32);
        strict_1.default.equal((0, dynamic_table_1.entrySize)('', ''), 32);
    });
    (0, node_test_1.test)('utf-8 multibyte names/values are measured in bytes', () => {
        // "中" is 3 bytes.
        strict_1.default.equal((0, dynamic_table_1.entrySize)('中', ''), 3 + 0 + 32);
    });
});
(0, node_test_1.describe)('insertion and FIFO eviction (Section 4.4)', () => {
    (0, node_test_1.test)('newest entry is at dynamic index 1', () => {
        const t = new dynamic_table_1.DynamicTable(256);
        t.add('a', '1');
        t.add('b', '2');
        strict_1.default.equal(t.get(1).name, 'b');
        strict_1.default.equal(t.get(2).name, 'a');
    });
    (0, node_test_1.test)('size and length track insertions', () => {
        const t = new dynamic_table_1.DynamicTable(256);
        t.add('a', '1');
        t.add('b', '2');
        strict_1.default.equal(t.length, 2);
        strict_1.default.equal(t.size, (0, dynamic_table_1.entrySize)('a', '1') + (0, dynamic_table_1.entrySize)('b', '2'));
    });
    (0, node_test_1.test)('oldest entries are evicted first when capacity is exceeded', () => {
        const t = new dynamic_table_1.DynamicTable((0, dynamic_table_1.entrySize)('a', '1') * 3);
        t.add('a', '1'); // size s
        t.add('b', '2'); // 2s
        t.add('c', '3'); // 3s: exactly full
        // Inserting d must evict a (oldest); b and c survive with d.
        t.add('d', '4');
        strict_1.default.equal(t.length, 3);
        strict_1.default.equal(t.get(1).name, 'd');
        strict_1.default.equal(t.get(2).name, 'c');
        strict_1.default.equal(t.get(3).name, 'b');
        strict_1.default.equal(t.get(4), undefined);
    });
    (0, node_test_1.test)('a single oversized entry empties the table and is not inserted', () => {
        const s = (0, dynamic_table_1.entrySize)('small', 'x');
        const t = new dynamic_table_1.DynamicTable(s * 2);
        t.add('small', 'x');
        t.add('small', 'x');
        strict_1.default.equal(t.length, 2);
        // Big value can never fit: table drains, big entry is not stored.
        const big = 'y'.repeat(s * 2);
        t.add('big', big);
        strict_1.default.equal(t.length, 0);
        strict_1.default.equal(t.size, 0);
    });
    (0, node_test_1.test)('get() out of range returns undefined', () => {
        const t = new dynamic_table_1.DynamicTable(256);
        t.add('a', '1');
        strict_1.default.equal(t.get(0), undefined);
        strict_1.default.equal(t.get(2), undefined);
    });
});
(0, node_test_1.describe)('capacity updates (Section 4.2)', () => {
    (0, node_test_1.test)('shrinking evicts oldest entries until everything fits', () => {
        const t = new dynamic_table_1.DynamicTable(512);
        t.add('a', '1');
        const s = (0, dynamic_table_1.entrySize)('a', '1');
        t.add('b', '2');
        t.add('c', '3');
        t.setMaxSize(s); // only the single newest entry can remain
        strict_1.default.equal(t.length, 1);
        strict_1.default.equal(t.get(1).name, 'c');
        strict_1.default.equal(t.size, s);
    });
    (0, node_test_1.test)('zero capacity empties the table', () => {
        const t = new dynamic_table_1.DynamicTable(256);
        t.add('a', '1');
        t.setMaxSize(0);
        strict_1.default.equal(t.length, 0);
        strict_1.default.equal(t.size, 0);
        strict_1.default.equal(t.maxSize, 0);
        // Nothing can be added at capacity zero.
        t.add('a', '1');
        strict_1.default.equal(t.length, 0);
    });
    (0, node_test_1.test)('growing capacity keeps all existing entries', () => {
        const t = new dynamic_table_1.DynamicTable(64);
        t.add('a', '1');
        t.setMaxSize(256);
        strict_1.default.equal(t.length, 1);
        strict_1.default.equal(t.get(1).name, 'a');
        strict_1.default.equal(t.maxSize, 256);
    });
    (0, node_test_1.test)('consecutive size updates each take effect immediately', () => {
        const t = new dynamic_table_1.DynamicTable(512);
        t.add('a', '1');
        const s = (0, dynamic_table_1.entrySize)('a', '1');
        t.add('b', '2');
        t.setMaxSize(s); // leaves only b
        strict_1.default.equal(t.length, 1);
        t.setMaxSize(0); // empties
        strict_1.default.equal(t.length, 0);
        t.setMaxSize(512); // large again, nothing restored
        strict_1.default.equal(t.length, 0);
        t.add('c', '3');
        strict_1.default.equal(t.length, 1);
    });
    (0, node_test_1.test)('update beyond the protocol maximum is rejected and leaves state intact', () => {
        const t = new dynamic_table_1.DynamicTable(128, 256);
        t.add('a', '1');
        strict_1.default.throws(() => t.setMaxSize(257), (err) => err instanceof errors_1.HpackDecodingError);
        strict_1.default.equal(t.maxSize, 128);
        strict_1.default.equal(t.length, 1);
    });
    (0, node_test_1.test)('negative and non-integer sizes are rejected', () => {
        const t = new dynamic_table_1.DynamicTable(128);
        strict_1.default.throws(() => t.setMaxSize(-1), errors_1.HpackDecodingError);
        strict_1.default.throws(() => t.setMaxSize(1.5), errors_1.HpackDecodingError);
    });
    (0, node_test_1.test)('constructor rejects an initial size over the limit', () => {
        strict_1.default.throws(() => new dynamic_table_1.DynamicTable(257, 256), errors_1.HpackDecodingError);
    });
});
(0, node_test_1.describe)('checkpoint / rollback', () => {
    (0, node_test_1.test)('restore() reinstates entries, size and capacity', () => {
        const t = new dynamic_table_1.DynamicTable(256);
        t.add('a', '1');
        const cp = t.checkpoint();
        t.add('b', '2');
        t.setMaxSize(0);
        strict_1.default.equal(t.length, 0);
        strict_1.default.equal(t.maxSize, 0);
        t.restore(cp);
        strict_1.default.equal(t.length, 1);
        strict_1.default.equal(t.get(1).name, 'a');
        strict_1.default.equal(t.maxSize, 256);
        strict_1.default.equal(t.size, (0, dynamic_table_1.entrySize)('a', '1'));
    });
});
(0, node_test_1.describe)('snapshot isolation', () => {
    (0, node_test_1.test)('snapshot reflects current contents newest first', () => {
        const t = new dynamic_table_1.DynamicTable(256);
        t.add('a', '1');
        t.add('b', '2');
        const snap = t.snapshot();
        strict_1.default.deepEqual(snap.entries.map(e => [e.name, e.value]), [
            ['b', '2'],
            ['a', '1'],
        ]);
        strict_1.default.equal(snap.maxSize, 256);
    });
    (0, node_test_1.test)('mutating the snapshot array cannot alter the table', () => {
        const t = new dynamic_table_1.DynamicTable(256);
        t.add('a', '1');
        const snap = t.snapshot();
        strict_1.default.throws(() => {
            'use strict';
            snap.entries.push({ name: 'evil', value: 'x', size: 1 });
        }, TypeError);
        strict_1.default.equal(t.length, 1);
    });
    (0, node_test_1.test)('mutating a snapshot entry object is frozen', () => {
        const t = new dynamic_table_1.DynamicTable(256);
        t.add('a', '1');
        const entry = t.snapshot().entries[0];
        strict_1.default.throws(() => {
            'use strict';
            entry.name = 'evil';
        }, TypeError);
        strict_1.default.equal(t.get(1).name, 'a');
    });
    (0, node_test_1.test)('snapshots are independent of later table changes', () => {
        const t = new dynamic_table_1.DynamicTable(256);
        t.add('a', '1');
        const before = t.snapshot();
        t.add('b', '2');
        t.setMaxSize(0);
        strict_1.default.equal(before.entries.length, 1);
        strict_1.default.equal(before.entries[0].name, 'a');
    });
});
