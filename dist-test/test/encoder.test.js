"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const encoder_1 = require("../src/encoder");
const decoder_1 = require("../src/decoder");
const errors_1 = require("../src/errors");
(0, node_test_1.describe)('encoder static indexing', () => {
    (0, node_test_1.test)('exact static entries are emitted as indexed fields', () => {
        const enc = new encoder_1.HpackEncoder();
        const out = enc.encode([
            { name: ':method', value: 'GET' },
            { name: ':scheme', value: 'http' },
            { name: ':path', value: '/' },
            { name: ':status', value: '200' },
        ]);
        strict_1.default.equal(out.toString('hex'), '82868488');
        strict_1.default.equal(enc.tableLength, 0);
    });
    (0, node_test_1.test)('name-only static match uses literal with that name reference', () => {
        const enc = new encoder_1.HpackEncoder();
        // :path /custom is not static; name is static index 4, literal value.
        const out = enc.encode([{ name: ':path', value: '/custom' }]);
        strict_1.default.equal(out.toString('hex'), '44072f637573746f6d');
    });
    (0, node_test_1.test)('RFC C.3.1 first request bytes match (authority indexed)', () => {
        const enc = new encoder_1.HpackEncoder();
        const out = enc.encode([
            { name: ':method', value: 'GET' },
            { name: ':scheme', value: 'http' },
            { name: ':path', value: '/' },
            { name: ':authority', value: 'www.example.com' },
        ]);
        strict_1.default.equal(out.toString('hex'), '828684410f7777772e6578616d706c652e636f6d');
    });
    (0, node_test_1.test)('C.3.2 exact dynamic value is reused as indexed field 62', () => {
        const enc = new encoder_1.HpackEncoder();
        enc.encode([
            { name: ':method', value: 'GET' },
            { name: ':scheme', value: 'http' },
            { name: ':path', value: '/' },
            { name: ':authority', value: 'www.example.com' },
        ]);
        const out = enc.encode([
            { name: ':method', value: 'GET' },
            { name: ':scheme', value: 'http' },
            { name: ':path', value: '/' },
            { name: ':authority', value: 'www.example.com' },
            { name: 'cache-control', value: 'no-cache' },
        ]);
        // 82 86 84 be (dynamic 62) 58 08 no-cache
        strict_1.default.equal(out.toString('hex'), '828684be58086e6f2d6361636865');
    });
});
(0, node_test_1.describe)('literal without / never indexing', () => {
    (0, node_test_1.test)('indexing "none" uses 0000xxxx and never enters the table', () => {
        const enc = new encoder_1.HpackEncoder();
        const out = enc.encode([
            { name: ':path', value: '/secret', indexing: 'none' },
        ]);
        // 04 (name idx 4) + len 7 + /secret
        strict_1.default.equal(out.toString('hex'), '04072f736563726574');
        strict_1.default.equal(enc.tableLength, 0);
    });
    (0, node_test_1.test)('indexing "never" uses 0001xxxx and never enters the table', () => {
        const enc = new encoder_1.HpackEncoder();
        const out = enc.encode([
            { name: 'authorization', value: 'bearer token', indexing: 'never' },
        ]);
        // authorization is static index 23, which saturates the 4-bit prefix
        // (15): 0001 1111 then 23-15 = 8 as the first continuation byte.
        strict_1.default.equal(out.subarray(0, 2).toString('hex'), '1f08');
        strict_1.default.equal(enc.tableLength, 0);
    });
    (0, node_test_1.test)('a never-indexed field that previously got indexed is still not referenced on repeat', () => {
        // Exact-match references from a normal insertion still encode fine,
        // but a field explicitly marked never must use the literal form.
        const enc = new encoder_1.HpackEncoder();
        enc.encode([{ name: 'x-secret', value: 's', indexing: 'never' }]);
        const out = enc.encode([
            { name: 'x-secret', value: 's', indexing: 'never' },
        ]);
        // Literal name (10 00) + "x-secret" + value "s".
        strict_1.default.equal(out.subarray(0, 1).toString('hex'), '10');
        strict_1.default.equal(enc.tableLength, 0);
    });
    (0, node_test_1.test)('literal name fallback with 4-bit prefix (no static/dynamic name)', () => {
        const enc = new encoder_1.HpackEncoder();
        const out = enc.encode([
            { name: 'x-custom', value: 'v', indexing: 'none' },
        ]);
        strict_1.default.equal(out.toString('hex'), '0008782d637573746f6d0176');
    });
});
(0, node_test_1.describe)('encoder dynamic table eviction', () => {
    (0, node_test_1.test)('insertion evicts oldest entries to respect capacity', () => {
        const enc = new encoder_1.HpackEncoder({ initialMaxTableSize: 40 });
        // name "a"/value "b" entry size = 1+1+32 = 34: only one fits.
        enc.encode([{ name: 'a', value: '1' }]);
        enc.encode([{ name: 'a', value: '2' }]);
        const snap = enc.snapshot();
        strict_1.default.equal(snap.entries.length, 1);
        strict_1.default.equal(snap.entries[0].value, '2');
    });
});
(0, node_test_1.describe)('encoder table size updates', () => {
    (0, node_test_1.test)('queued update is prefixed to the next block once', () => {
        const enc = new encoder_1.HpackEncoder();
        enc.setTableSizeUpdate(0);
        const out = enc.encode([{ name: ':method', value: 'GET' }]);
        strict_1.default.equal(out.subarray(0, 1).toString('hex'), '20');
        strict_1.default.equal(out.toString('hex'), '2082');
        // Not re-emitted on the following block.
        const next = enc.encode([{ name: ':method', value: 'GET' }]);
        strict_1.default.equal(next.toString('hex'), '82');
    });
    (0, node_test_1.test)('multiple queued updates appear consecutively and evict in order', () => {
        const enc = new encoder_1.HpackEncoder();
        enc.encode([{ name: 'a', value: '1' }]); // 34 bytes
        enc.setTableSizeUpdate(0); // evicts
        enc.setTableSizeUpdate(256); // regrows
        const out = enc.encode([{ name: ':method', value: 'GET' }]);
        // 20 (size 0) then 3f 02 (31+2=33)? 256 => 31 + 225 = 0x3f 0xe1 0x01
        strict_1.default.equal(out.subarray(0, 1).toString('hex'), '20');
        strict_1.default.equal(out.subarray(1, 4).toString('hex'), '3fe101');
        strict_1.default.equal(enc.tableLength, 0);
        strict_1.default.equal(enc.maxTableSize, 256);
    });
    (0, node_test_1.test)('per-call option updates are emitted on this block only', () => {
        const enc = new encoder_1.HpackEncoder();
        const first = enc.encode([{ name: ':method', value: 'GET' }], {
            tableSizeUpdates: [0],
        });
        strict_1.default.equal(first.toString('hex'), '2082');
        const second = enc.encode([{ name: ':method', value: 'GET' }]);
        strict_1.default.equal(second.toString('hex'), '82');
    });
    (0, node_test_1.test)('update beyond the negotiated maximum is rejected', () => {
        const enc = new encoder_1.HpackEncoder({
            initialMaxTableSize: 128,
            maxTableSizeLimit: 256,
        });
        strict_1.default.throws(() => enc.setTableSizeUpdate(257), errors_1.HpackEncodingError);
        strict_1.default.equal(enc.maxTableSize, 128);
    });
});
(0, node_test_1.describe)('encoder validation and Huffman opt-in', () => {
    (0, node_test_1.test)('empty name and non-string value are rejected', () => {
        const enc = new encoder_1.HpackEncoder();
        strict_1.default.throws(() => enc.encode([{ name: '', value: 'x' }]), errors_1.HpackEncodingError);
        strict_1.default.throws(() => enc.encode([{ name: 'x', value: 42 }]), errors_1.HpackEncodingError);
    });
    (0, node_test_1.test)('unknown indexing mode is rejected', () => {
        const enc = new encoder_1.HpackEncoder();
        strict_1.default.throws(() => enc.encode([
            { name: 'x', value: 'y', indexing: 'bogus' },
        ]), errors_1.HpackEncodingError);
    });
    (0, node_test_1.test)('requesting Huffman coding throws the explicit unsupported error', () => {
        const enc = new encoder_1.HpackEncoder();
        strict_1.default.throws(() => enc.setHuffmanEnabled(true), errors_1.HuffmanUnsupportedError);
        strict_1.default.doesNotThrow(() => enc.setHuffmanEnabled(false));
    });
    (0, node_test_1.test)('a failed encode leaves table state and queued updates untouched', () => {
        const enc = new encoder_1.HpackEncoder();
        enc.encode([{ name: 'keep', value: '1' }]);
        enc.setTableSizeUpdate(0); // queued; capacity already applied (evicts)
        strict_1.default.throws(() => enc.encode([
            { name: 'good', value: 'x' },
            { name: '', value: 'invalid' },
        ]), errors_1.HpackEncodingError);
        // No half-encoded entry survived...
        strict_1.default.equal(enc.tableLength, 0);
        // ...and the queued update is still armed for the next good block.
        const next = enc.encode([{ name: ':method', value: 'GET' }]);
        strict_1.default.equal(next.toString('hex'), '2082');
        // Only emitted once.
        strict_1.default.equal(enc.encode([{ name: ':method', value: 'GET' }]).toString('hex'), '82');
    });
    (0, node_test_1.test)('an oversized per-call size update aborts without partial effects', () => {
        const enc = new encoder_1.HpackEncoder({
            initialMaxTableSize: 128,
            maxTableSizeLimit: 256,
        });
        enc.encode([{ name: 'keep', value: '1' }]);
        strict_1.default.throws(() => enc.encode([{ name: 'a', value: 'b' }], { tableSizeUpdates: [257] }), errors_1.HpackEncodingError);
        strict_1.default.equal(enc.maxTableSize, 128);
        strict_1.default.equal(enc.tableLength, 1);
        strict_1.default.equal(enc.snapshot().entries[0].name, 'keep');
    });
});
(0, node_test_1.describe)('encoder/decoder cross-validation', () => {
    (0, node_test_1.test)('everything the encoder emits decodes back to the same headers', () => {
        const enc = new encoder_1.HpackEncoder();
        const dec = new decoder_1.HpackDecoder();
        const blocks = [
            [
                { name: ':method', value: 'GET' },
                { name: ':scheme', value: 'https' },
                { name: ':path', value: '/' },
                { name: ':authority', value: 'example.com' },
                { name: 'authorization', value: 'Bearer abc', indexing: 'never' },
            ],
            [
                { name: ':method', value: 'GET' },
                { name: ':authority', value: 'example.com' }, // dynamic exact match
                { name: 'x-trace', value: '1234567890', indexing: 'none' },
            ],
            [
                { name: 'custom-utf8', value: 'héllo-世界' },
                { name: 'cookie', value: 'a=b; c=d', indexing: 'never' },
            ],
        ];
        for (const block of blocks) {
            const wire = enc.encode(block);
            const decoded = dec.decode(wire);
            strict_1.default.equal(decoded.length, block.length);
            for (let i = 0; i < block.length; i++) {
                strict_1.default.equal(decoded[i].name, block[i].name);
                strict_1.default.equal(decoded[i].value, block[i].value);
                strict_1.default.equal(decoded[i].indexing, block[i].indexing ?? 'indexed');
            }
            // Encoder and decoder dynamic tables must stay in lockstep.
            strict_1.default.deepEqual(enc.snapshot().entries.map(e => [e.name, e.value, e.size]), dec.snapshot().entries.map(e => [e.name, e.value, e.size]));
            strict_1.default.equal(enc.tableSize, dec.tableSize);
        }
    });
    (0, node_test_1.test)('eviction order stays synchronized when capacity is tight', () => {
        const enc = new encoder_1.HpackEncoder({ initialMaxTableSize: 70 });
        const dec = new decoder_1.HpackDecoder({ initialMaxTableSize: 70 });
        for (let i = 0; i < 5; i++) {
            const headers = [
                { name: `k${i}`, value: `v${i}-xxxxxxxxxxxx` },
            ];
            const wire = enc.encode(headers);
            const decoded = dec.decode(wire);
            strict_1.default.equal(decoded[0].name, `k${i}`);
            strict_1.default.deepEqual(enc.snapshot().entries.map(e => e.name), dec.snapshot().entries.map(e => e.name));
        }
    });
    (0, node_test_1.test)('encoder instance isolation: independent dynamic tables', () => {
        const a = new encoder_1.HpackEncoder();
        const b = new encoder_1.HpackEncoder();
        a.encode([{ name: 'x-a', value: '1' }]);
        strict_1.default.equal(a.tableLength, 1);
        strict_1.default.equal(b.tableLength, 0);
        // Each encoder feeds its own decoder; a dynamic reference emitted by
        // `a` must not be resolvable in a decoder belonging to another
        // connection.
        const pairedA = new decoder_1.HpackDecoder();
        const pairedB = new decoder_1.HpackDecoder();
        // `a` already holds x-a, so every later emission is the bare dynamic
        // reference 0xbe (index 62).
        const referenceWire = a.encode([{ name: 'x-a', value: '1' }]);
        strict_1.default.equal(referenceWire.toString('hex'), 'be');
        // A foreign decoder with no matching state rejects that reference.
        strict_1.default.throws(() => pairedB.decode(referenceWire), {
            code: 'INDEX_OUT_OF_RANGE',
        });
        // A separate connection that independently built the same state
        // accepts the reference and does not duplicate the entry.
        const seeder = new encoder_1.HpackEncoder();
        pairedA.decode(seeder.encode([{ name: 'x-a', value: '1' }]));
        strict_1.default.doesNotThrow(() => pairedA.decode(Buffer.from('be', 'hex')));
        strict_1.default.equal(pairedA.tableLength, 1);
    });
});
