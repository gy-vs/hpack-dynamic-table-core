import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DecodedHeaderField,
  DynamicTable,
  ENTRY_OVERHEAD,
  HpackDecodingError,
  HpackDecoder,
  HpackEncoder,
  HuffmanUnsupportedError,
  STATIC_TABLE,
  STATIC_TABLE_LENGTH,
  encodeInteger,
} from "../src/index.js";

function roundtrip(
  headers: Parameters<HpackEncoder["encode"]>[0],
  encoder = new HpackEncoder(),
  decoder = new HpackDecoder(),
): { decoded: DecodedHeaderField[]; encoder: HpackEncoder; decoder: HpackDecoder } {
  const block = encoder.encode(headers);
  return { decoded: decoder.decode(block), encoder, decoder };
}

describe("integer encoding (RFC 7541 5.1)", () => {
  it("single byte for every prefix when value fits", () => {
    for (const prefixBits of [1, 3, 4, 5, 6, 7, 8]) {
      const max = 2 ** prefixBits - 1;
      assert.deepEqual(encodeInteger(0, prefixBits), Buffer.from([0]));
      assert.deepEqual(encodeInteger(max - 1, prefixBits), Buffer.from([max - 1]));
    }
    // RFC 7541 C.1.1
    assert.deepEqual(encodeInteger(10, 5), Buffer.from([10]));
  });

  it("preserves high context bits", () => {
    assert.deepEqual(encodeInteger(2, 7, 0x80), Buffer.from([0x82])); // indexed :method GET
    assert.deepEqual(encodeInteger(0, 6, 0x40), Buffer.from([0x40])); // incremental, name literal
    assert.deepEqual(encodeInteger(62, 6, 0x40), Buffer.from([0x7e]));
    assert.deepEqual(encodeInteger(0, 5, 0x20), Buffer.from([0x20])); // size update 0
  });

  it("multi-byte encodings match RFC 7541 examples", () => {
    // C.1.2: 1337 with 5-bit prefix -> 31, 154, 10
    assert.deepEqual(encodeInteger(1337, 5), Buffer.from([31, 154, 10]));
    // C.1.3: 42 with 8-bit prefix -> single byte 42
    assert.deepEqual(encodeInteger(42, 8), Buffer.from([42]));
  });

  it("multi-byte boundaries for several prefix sizes", () => {
    const cases: Array<[number, number, number[]]> = [
      [126, 7, [126]],
      // value 127 = max + 0 -> prefix 127, continuation 0
      [127, 7, [127, 0]],
      [128, 7, [127, 1]],
      [191, 7, [127, 64]],
      [192, 7, [127, 65]],
      [254, 7, [127, 127]],
      [255, 7, [127, 128, 1]],
      [62, 6, [62]],
      [63, 6, [63, 0]],
      [64, 6, [63, 1]],
      [14, 5, [14]],
      [30, 5, [30]],
      [31, 5, [31, 0]],
      [32, 5, [31, 1]],
      [95, 5, [31, 64]],
      [14, 4, [14]],
      [16, 4, [15, 1]],
      [100, 4, [15, 85]], // 15 + 85 = 100
      [0, 1, [0]],
      [2, 1, [1, 1]],
    ];
    for (const [value, prefixBits, expected] of cases) {
      assert.deepEqual(
        Array.from(encodeInteger(value, prefixBits)),
        expected,
        `value=${value} prefix=${prefixBits}`,
      );
    }
  });

  it("round-trips large multi-byte indices via encoder+decoder", () => {
    // The oldest of 250 fresh entries lands on wire index 61 + 250 = 311.
    const enc = new HpackEncoder(16384);
    const dec = new HpackDecoder(16384);
    const headers = Array.from({ length: 250 }, (_, i) => ({
      name: `name-${i}`,
      value: "x",
    }));
    dec.decode(enc.encode(headers));
    const indexed = enc.encode([{ name: "name-0", value: "x" }]);
    assert.ok(indexed.length >= 2, "index 311 must be multibyte encoded");
    const decoded = dec.decode(indexed);
    assert.deepEqual(decoded, [{ name: "name-0", value: "x", sensitive: false }]);
  });

  it("rejects non-integer and oversized values", () => {
    assert.throws(() => encodeInteger(-1, 5), RangeError);
    assert.throws(() => encodeInteger(1.5, 5), RangeError);
    assert.throws(() => encodeInteger(Number.MAX_SAFE_INTEGER + 1, 5), RangeError);
  });
});

describe("reader error handling", () => {
  it("rejects truncated continuation integers", () => {
    const dec = new HpackDecoder();
    // indexed, prefix 127 followed by one continuation byte but no terminator.
    assert.throws(() => dec.decode(Buffer.from([0xff, 0x80])), HpackDecodingError);
  });

  it("decodes multibyte integers at prefix boundaries", () => {
    const enc = new HpackEncoder(16384);
    const dec = new HpackDecoder(16384);
    // Fill enough entries that references cross the 7-bit prefix boundary.
    const headers = Array.from({ length: 200 }, (_, i) => ({
      name: `h${i}`,
      value: "v",
    }));
    dec.decode(enc.encode(headers));

    // Single-byte dynamic index: newest entry -> wire index 62.
    assert.deepEqual(dec.decode(enc.encode([{ name: "h199", value: "v" }])), [
      { name: "h199", value: "v", sensitive: false },
    ]);
    // Entry h74 sits on wire index 62 + 125 = 187 -> continuation value 60.
    assert.deepEqual(dec.decode(enc.encode([{ name: "h74", value: "v" }])), [
      { name: "h74", value: "v", sensitive: false },
    ]);
    // Entry h0 sits on wire index 261 -> continuation value 134.
    assert.deepEqual(dec.decode(enc.encode([{ name: "h0", value: "v" }])), [
      { name: "h0", value: "v", sensitive: false },
    ]);
  });

  it("decodes an empty block to no headers", () => {
    assert.deepEqual(new HpackDecoder().decode(Buffer.alloc(0)), []);
  });

  it("matches RFC 7541 C.2.1 raw (non-Huffman) encoding", () => {
    // C.2.1 first request, with Huffman replaced by raw strings:
    //   400a custom-key 0d custom-header
    const block = Buffer.concat([
      Buffer.from([0x40, 0x0a]),
      Buffer.from("custom-key"),
      Buffer.from([0x0d]),
      Buffer.from("custom-header"),
    ]);
    assert.deepEqual(new HpackDecoder().decode(block), [
      { name: "custom-key", value: "custom-header", sensitive: false },
    ]);
  });

  it("rejects continuation integers larger than 32 bits", () => {
    const dec = new HpackDecoder();
    // Five continuation bytes push the value past 2^32.
    assert.throws(
      () => dec.decode(Buffer.from([0xff, 0x80, 0x80, 0x80, 0x80, 0x10])),
      HpackDecodingError,
    );
  });

  it("rejects truncated strings", () => {
    const dec = new HpackDecoder();
    // incremental indexing, name index 0, string length 10 but 3 bytes follow.
    assert.throws(
      () => dec.decode(Buffer.from([0x40, 0x0a, 0x61, 0x62, 0x63])),
      HpackDecodingError,
    );
    // Truncated value too.
    assert.throws(() => dec.decode(Buffer.from([0x40, 0x03, 0x61, 0x62])), HpackDecodingError);
  });
});

describe("static table", () => {
  it("contains the 61 RFC 7541 Appendix A entries", () => {
    assert.equal(STATIC_TABLE_LENGTH, 61);
    assert.equal(STATIC_TABLE[0]!.name, ":authority");
    assert.equal(STATIC_TABLE[1]!.value, "GET");
    assert.equal(STATIC_TABLE[60]!.name, "www-authenticate");
  });

  it("encodes common requests per RFC 7541 C.3", () => {
    const enc = new HpackEncoder();
    const dec = new HpackDecoder();
    const block = enc.encode([
      { name: ":method", value: "GET" },
      { name: ":scheme", value: "http" },
      { name: ":path", value: "/" },
      { name: ":authority", value: "www.example.com" },
    ]);
    // RFC 7541 C.3 request examples, request 1 without Huffman coding.
    const host = "www.example.com";
    const expected = Buffer.concat([
      Buffer.from([0x82, 0x86, 0x84, 0x41, host.length]),
      Buffer.from(host),
    ]);
    assert.deepEqual(block, expected);
    const decoded = dec.decode(block);
    assert.deepEqual(
      decoded.map((h) => [h.name, h.value]),
      [
        [":method", "GET"],
        [":scheme", "http"],
        [":path", "/"],
        [":authority", "www.example.com"],
      ],
    );
  });

  it("encodes a static name with a different value as a literal", () => {
    const enc = new HpackEncoder();
    const block = enc.encode([{ name: ":path", value: "/new" }]);
    // 0x44 = incremental indexing referencing static index 4 (:path)
    assert.equal(block[0], 0x44);
    const decoded = new HpackDecoder().decode(block);
    assert.deepEqual(decoded, [{ name: ":path", value: "/new", sensitive: false }]);
  });
});

describe("literal header fields and dynamic table", () => {
  it("inserts incrementally-indexed fields and reuses them in later blocks", () => {
    const enc = new HpackEncoder();
    const dec = new HpackDecoder();
    const first = enc.encode([{ name: "custom-key", value: "custom-header" }]);
    assert.deepEqual(
      first,
      Buffer.from([0x40, 0x0a, ...Buffer.from("custom-key"), 0x0d, ...Buffer.from("custom-header")]),
    );
    const headers1 = dec.decode(first);
    assert.deepEqual(headers1, [
      { name: "custom-key", value: "custom-header", sensitive: false },
    ]);
    assert.deepEqual(dec.snapshot().entries, [{ name: "custom-key", value: "custom-header" }]);

    // Second block references the dynamic entry: indexed representation 62.
    const second = enc.encode([{ name: "custom-key", value: "custom-header" }]);
    assert.deepEqual(second, Buffer.from([0xbe]));
    const headers2 = dec.decode(second);
    assert.deepEqual(headers2, [{ name: "custom-key", value: "custom-header", sensitive: false }]);
  });

  it("encodes without-indexing fields and keeps them out of the table", () => {
    const enc = new HpackEncoder();
    const dec = new HpackDecoder();
    const block = enc.encode([
      { name: "x-cache", value: "miss", indexing: "none" },
      { name: "x-other", value: "1", indexing: "indexed" },
    ]);
    // First field: 0x00 = without indexing, name literal.
    assert.equal(block[0], 0x00);
    dec.decode(block);
    const names = dec.snapshot().entries.map((e) => e.name);
    assert.deepEqual(names, ["x-other"]);
  });

  it("marks sensitive fields never-indexed on both sides", () => {
    const enc = new HpackEncoder();
    const dec = new HpackDecoder();
    const block = enc.encode([
      { name: "authorization", value: "Bearer secret", indexing: "never" },
      { name: "x-safe", value: "ok", indexing: "indexed" },
    ]);
    // authorization is static index 23, which exceeds the 4-bit prefix (15),
    // so it is encoded as a multibyte prefix integer: 0x1f (0x10|15), 8.
    assert.equal(block[0], 0x1f);
    assert.equal(block[1], 8);
    const decoded = dec.decode(block);
    assert.equal(decoded[0]!.sensitive, true);
    assert.equal(decoded[0]!.name, "authorization");
    assert.equal(decoded[0]!.value, "Bearer secret");
    assert.equal(decoded[1]!.sensitive, false);
    const names = dec.snapshot().entries.map((e) => e.name);
    assert.deepEqual(names, ["x-safe"]);
  });

  it("never-indexed field with fresh name still carries a name literal and no table entry", () => {
    const dec = new HpackDecoder();
    // 0x10 name index 0, name "token" length 5, value "abc" length 3.
    const block = Buffer.concat([
      Buffer.from([0x10, 0x05]),
      Buffer.from("token"),
      Buffer.from([0x03]),
      Buffer.from("abc"),
    ]);
    const decoded = dec.decode(block);
    assert.deepEqual(decoded, [{ name: "token", value: "abc", sensitive: true }]);
    assert.equal(dec.snapshot().entries.length, 0);
  });

  it("computes entry sizes from UTF-8 byte lengths plus 32", () => {
    const table = new DynamicTable(1000);
    table.add("name", "value");
    assert.equal(table.size, 4 + 5 + ENTRY_OVERHEAD);
    const cjk = "日本語"; // 9 bytes
    table.add("lang", cjk);
    assert.equal(table.size, 4 + 5 + ENTRY_OVERHEAD + 4 + 9 + ENTRY_OVERHEAD);
  });

  it("round-trips multibyte UTF-8 values", () => {
    const { decoded } = roundtrip([{ name: "x-lang", value: "こんにちは" }]);
    assert.deepEqual(decoded, [{ name: "x-lang", value: "こんにちは", sensitive: false }]);
  });
});

describe("Huffman is explicitly unsupported", () => {
  it("throws HuffmanUnsupportedError on a Huffman-coded name", () => {
    const dec = new HpackDecoder();
    // incremental, name index 0, string with H bit set, length 8.
    const block = Buffer.from([0x40, 0x88, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.throws(
      () => dec.decode(block),
      (err: unknown) => err instanceof HuffmanUnsupportedError,
    );
  });

  it("throws HuffmanUnsupportedError on a Huffman-coded value", () => {
    const dec = new HpackDecoder();
    // without indexing, name "a", value H-bit length 3.
    const block = Buffer.from([0x00, 0x01, 0x61, 0x83, 0x00, 0x00, 0x00]);
    assert.throws(() => dec.decode(block), HuffmanUnsupportedError);
  });

  it("a Huffman error rolls the whole block back", () => {
    const dec = new HpackDecoder();
    // First insert a valid entry in the same block, then hit a Huffman value.
    const good = new HpackEncoder().encode([{ name: "keep", value: "me" }]);
    const bad = Buffer.concat([good, Buffer.from([0x00, 0x01, 0x61, 0x82, 0x00, 0x00])]);
    assert.throws(() => dec.decode(bad), HuffmanUnsupportedError);
    assert.deepEqual(dec.snapshot().entries, []);
    assert.equal(dec.snapshot().size, 0);
  });
});

describe("out-of-range indices", () => {
  it("rejects indexed representation index 0", () => {
    const dec = new HpackDecoder();
    assert.throws(() => dec.decode(Buffer.from([0x80])), HpackDecodingError);
  });

  it("rejects static index beyond 61", () => {
    const dec = new HpackDecoder();
    // indexed 62, empty dynamic table.
    assert.throws(() => dec.decode(Buffer.from([0xbe])), HpackDecodingError);
    assert.throws(() => dec.decode(Buffer.from([0xff, 0x00])), HpackDecodingError); // index 127
  });

  it("rejects bad name index in literal representations", () => {
    const dec = new HpackDecoder();
    // Static table has 61 entries; index 100 (multibyte prefix in each shape).
    assert.throws(() => dec.decode(Buffer.from([0x4f, 85, 0x01, 0x78])), HpackDecodingError);
    assert.throws(() => dec.decode(Buffer.from([0x1f, 85, 0x01, 0x78])), HpackDecodingError);
    assert.throws(() => dec.decode(Buffer.from([0x0f, 85, 0x01, 0x78])), HpackDecodingError);
  });
});

describe("failure rollback", () => {
  it("restores table after an insert-later-in-block fails", () => {
    const enc = new HpackEncoder();
    const dec = new HpackDecoder();
    dec.decode(enc.encode([{ name: "before", value: "1" }]));

    // A block that inserts "partial" and then references a missing index: the
    // whole block must roll back, including the earlier insertion.
    const good = enc.encode([{ name: "partial", value: "2" }]);
    const bad = Buffer.concat([good, Buffer.from(encodeInteger(200, 7, 0x80))]);
    assert.throws(() => dec.decode(bad), HpackDecodingError);

    const after = dec.snapshot();
    assert.deepEqual(after.entries.map((e) => e.name), ["before"]);

    // The same prefix without the trailing error commits normally.
    dec.decode(good);
    assert.deepEqual(dec.snapshot().entries.map((e) => e.name), ["before", "partial"]);
  });

  it("does not emit headers from a rolled-back block", () => {
    const dec = new HpackDecoder();
    const good = new HpackEncoder().encode([{ name: "a", value: "1" }]);
    const bad = Buffer.concat([good, Buffer.from([0x00, 0x09, 0x74])]); // truncated string
    assert.throws(() => dec.decode(bad), HpackDecodingError);
    assert.deepEqual(dec.snapshot().entries, []);
  });

  it("rolls back size updates when a later representation fails", () => {
    const dec = new HpackDecoder(500);
    // Size update to 100 followed by a reference to missing dynamic index 62.
    const bad = Buffer.concat([Buffer.from(encodeInteger(100, 5, 0x20)), Buffer.from([0xbe])]);
    assert.throws(() => dec.decode(bad), HpackDecodingError);
    assert.equal(dec.snapshot().maxSize, 500);
    assert.deepEqual(dec.snapshot().entries, []);
  });
});

describe("dynamic table size updates", () => {
  it("decodes a size update and evicts to fit", () => {
    const enc = new HpackEncoder(200);
    const dec = new HpackDecoder(200);
    dec.decode(
      enc.encode([
        { name: "a", value: "1" },
        { name: "b", value: "22" },
        { name: "c", value: "333" },
      ]),
    );
    assert.equal(dec.snapshot().entries.length, 3);

    // One block: two size updates (0, then 100) plus one fresh insert.
    enc.updateTableSize(0);
    enc.updateTableSize(100);
    const block = enc.encode([{ name: "a", value: "1" }]);
    // Size 0 -> 0x20; size 100 with 5-bit prefix max 31 -> 0x3f, 69.
    assert.deepEqual(block.subarray(0, 3), Buffer.from([0x20, 0x3f, 69]));
    const decoded = dec.decode(block);
    assert.deepEqual(decoded, [{ name: "a", value: "1", sensitive: false }]);
    assert.equal(dec.snapshot().maxSize, 100);
    assert.equal(dec.snapshot().entries.length, 1);
  });

  it("keeps consecutive updates in order and applies final capacity", () => {
    const dec = new HpackDecoder(500);
    // size updates 400, 0, 250 inside one block, then a small insert.
    const block = Buffer.concat([
      Buffer.from(encodeInteger(400, 5, 0x20)),
      Buffer.from(encodeInteger(0, 5, 0x20)),
      Buffer.from(encodeInteger(250, 5, 0x20)),
      new HpackEncoder().encode([{ name: "a", value: "1" }]),
    ]);
    dec.decode(block);
    const snap = dec.snapshot();
    assert.equal(snap.maxSize, 250);
    assert.deepEqual(snap.entries, [{ name: "a", value: "1" }]);
  });

  it("rejects a size update after a header field and rolls back", () => {
    const dec = new HpackDecoder(500);
    const field = new HpackEncoder().encode([{ name: "a", value: "1" }]);
    const block = Buffer.concat([field, Buffer.from(encodeInteger(100, 5, 0x20))]);
    assert.throws(() => dec.decode(block), HpackDecodingError);
    assert.deepEqual(dec.snapshot().entries, []);
    assert.equal(dec.snapshot().maxSize, 500);
  });

  it("rejects a size update above the advertised SETTINGS limit", () => {
    const dec = new HpackDecoder(100);
    assert.throws(
      () => dec.decode(Buffer.from(encodeInteger(101, 5, 0x20))),
      HpackDecodingError,
    );
    assert.equal(dec.snapshot().maxSize, 100);
  });

  it("encoder refuses to advertise a size above its limit", () => {
    const enc = new HpackEncoder(100);
    assert.throws(() => enc.updateTableSize(101), /limit/);
  });

  it("queues encoder size updates onto the next block and only the next", () => {
    const enc = new HpackEncoder(300);
    const dec = new HpackDecoder(300);
    enc.updateTableSize(0);
    enc.updateTableSize(120);
    // Local encoder state reflects the final capacity immediately.
    assert.equal(enc.snapshot().maxSize, 120);
    const block1 = enc.encode([{ name: "a", value: "1" }]);
    // Both updates are serialized, in order, before the first header field.
    assert.deepEqual(block1.subarray(0, 3), Buffer.from([0x20, 0x3f, 0x59]));
    dec.decode(block1);
    assert.equal(dec.snapshot().maxSize, 120);
    // A subsequent block carries no stale updates.
    const block2 = enc.encode([{ name: "a", value: "1" }]);
    assert.equal(block2[0], 0xbe);
    dec.decode(block2);
    assert.equal(dec.snapshot().entries.length, 1);
  });

  it("local setMaxTableSize on the decoder evicts oldest-first", () => {
    const dec = new HpackDecoder(500);
    dec.decode(
      new HpackEncoder(500).encode([
        { name: "a", value: "1" },
        { name: "b", value: "2" },
        { name: "c", value: "3" },
      ]),
    );
    dec.setMaxTableSize(33); // smaller than every entry (34) -> whole table clears
    assert.equal(dec.snapshot().size, 0);
    assert.equal(dec.snapshot().entries.length, 0);
    assert.equal(dec.snapshot().maxSize, 33);
  });
});

describe("eviction order", () => {
  it("evicts oldest entries first and reports wire-visible size", () => {
    const enc = new HpackEncoder(110);
    const dec = new HpackDecoder(110);
    const send = (n: string, v: string) =>
      dec.decode(enc.encode([{ name: n, value: v }]));

    for (const n of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      send(n, "x");
    }
    // Every entry is 1+1+32 = 34 bytes; capacity 110 holds 3.
    const snap = dec.snapshot();
    assert.equal(snap.entries.length, 3);
    assert.deepEqual(
      snap.entries.map((e) => e.name),
      ["f", "g", "h"],
    );
    assert.equal(snap.size, 3 * 34);
    // Encoder mirrors the decoder.
    assert.deepEqual(
      enc.snapshot().entries.map((e) => e.name),
      ["f", "g", "h"],
    );
  });

  it("an entry larger than the capacity empties the table without protocol error", () => {
    const enc = new HpackEncoder(100);
    const dec = new HpackDecoder(100);
    dec.decode(enc.encode([{ name: "a", value: "x" }]));
    const giant = "y".repeat(200);
    assert.doesNotThrow(() => dec.decode(enc.encode([{ name: "big", value: giant }])));
    assert.equal(dec.snapshot().entries.length, 0);
    assert.equal(dec.snapshot().size, 0);
  });
});

describe("state isolation and reuse", () => {
  it("reuses dynamic state across consecutive blocks on one connection", () => {
    const enc = new HpackEncoder();
    const dec = new HpackDecoder();
    dec.decode(enc.encode([{ name: "session", value: "abc" }]));
    assert.deepEqual(dec.snapshot().entries.map((e) => e.name), ["session"]);
    const indexed = enc.encode([{ name: "session", value: "abc" }]);
    assert.deepEqual(indexed, Buffer.from([0xbe]));
    const decoded = dec.decode(indexed);
    assert.deepEqual(decoded, [{ name: "session", value: "abc", sensitive: false }]);
    assert.equal(dec.snapshot().entries.length, 1);
  });

  it("isolates dynamic tables across connection instances", () => {
    const encA = new HpackEncoder();
    const decA = new HpackDecoder();
    const encB = new HpackEncoder();
    const decB = new HpackDecoder();

    decA.decode(encA.encode([{ name: "conn-a", value: "1" }]));
    decB.decode(encB.encode([{ name: "conn-b", value: "2" }]));

    assert.deepEqual(decA.snapshot().entries.map((e) => e.name), ["conn-a"]);
    assert.deepEqual(decB.snapshot().entries.map((e) => e.name), ["conn-b"]);
    assert.deepEqual(encA.snapshot().entries.map((e) => e.name), ["conn-a"]);
    assert.deepEqual(encB.snapshot().entries.map((e) => e.name), ["conn-b"]);

    // A literal name index beyond B's table is a protocol error on B.
    const cross = Buffer.from([0x4f, 85, 0x01, 0x78]); // incremental, name index 100
    assert.throws(() => decB.decode(cross), HpackDecodingError);
    // B's untouched state survived the failed decode of A's block.
    assert.deepEqual(decB.snapshot().entries.map((e) => e.name), ["conn-b"]);
  });

  it("different decoder limits do not affect other instances", () => {
    const small = new HpackDecoder(33);
    const big = new HpackDecoder(4096);
    assert.throws(
      () => small.decode(Buffer.from(encodeInteger(100, 5, 0x20))),
      HpackDecodingError,
    );
    assert.doesNotThrow(() => big.decode(Buffer.from(encodeInteger(100, 5, 0x20))));
    assert.equal(big.snapshot().maxSize, 100);
    assert.equal(small.snapshot().maxSize, 33);
  });
});

describe("snapshot immutability", () => {
  it("returns a detached deep copy", () => {
    const dec = new HpackDecoder();
    dec.decode(new HpackEncoder().encode([{ name: "k", value: "v" }]));
    const snap1 = dec.snapshot();
    const mutated = snap1.entries as unknown as Array<{ name: string; value: string }>;
    // Mutating the received array must not touch internal state.
    mutated.push({ name: "injected", value: "x" });
    mutated[0]!.name = "changed";
    const snap2 = dec.snapshot();
    assert.deepEqual(snap2.entries, [{ name: "k", value: "v" }]);
    assert.equal(snap2.entries.length, 1);
    assert.equal(snap1.maxSize, snap2.maxSize);
  });

  it("older snapshots stay valid after later evictions", () => {
    const enc = new HpackEncoder(70);
    const dec = new HpackDecoder(70);
    dec.decode(enc.encode([{ name: "k", value: "v1" }]));
    const old = dec.snapshot();
    // A bigger new entry evicts "k"; the old snapshot must still describe it.
    dec.decode(enc.encode([{ name: "longer-name", value: "longer-value" }]));
    assert.deepEqual(old.entries, [{ name: "k", value: "v1" }]);
    assert.equal(dec.snapshot().entries.some((e) => e.name === "k"), false);
  });
});

describe("multibyte indexed headers", () => {
  it("indexes and references a dynamic entry beyond index 255", () => {
    // Entries "name-i" = "x" average ~39 bytes each; 16 KiB holds all 250.
    const enc = new HpackEncoder(16384);
    const dec = new HpackDecoder(16384);
    const headers = Array.from({ length: 250 }, (_, i) => ({
      name: `name-${i}`,
      value: "x",
    }));
    dec.decode(enc.encode(headers));
    assert.equal(dec.snapshot().entries.length, 250);

    // The oldest entry has wire index 61 + 250 = 311: needs multibyte integer.
    const block = enc.encode([{ name: "name-0", value: "x" }]);
    assert.ok(block.length >= 2, "index 311 must be multibyte encoded");
    const decoded = dec.decode(block);
    assert.deepEqual(decoded, [{ name: "name-0", value: "x", sensitive: false }]);
  });

  it("never-indexed reference to a multibyte static/dynamic name index", () => {
    const enc = new HpackEncoder(8192);
    const dec = new HpackDecoder(8192);
    const headers = Array.from({ length: 195 }, (_, i) => ({
      name: `n${i}`,
      value: "v",
    }));
    dec.decode(enc.encode(headers));
    const block = enc.encode([{ name: "n0", value: "different", indexing: "never" }]);
    const first = block[0]!;
    assert.equal(first & 0xf0, 0x10);
    assert.ok(block.length > 2, "name index 256 needs a multibyte 4-bit-prefix integer");
    const decoded = dec.decode(block);
    assert.equal(decoded[0]!.sensitive, true);
    assert.equal(decoded[0]!.value, "different");
  });
});
