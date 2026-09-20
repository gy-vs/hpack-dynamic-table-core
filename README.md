# hpack-dynamic-table-core

A small, dependency-free **HPACK subset** ([RFC 7541](https://www.rfc-editor.org/rfc/rfc7541))
for encoding and decoding HTTP/2 header blocks in **test environments**.
Written in TypeScript for Node.js 20+, with no use of Node's `http2`
module and no third-party HPACK implementation.

## What is implemented

| Feature | RFC section |
| --- | --- |
| Indexed header fields (static + dynamic tables) | 6.1 |
| Literal header field with incremental indexing | 6.2.1 |
| Literal header field without indexing | 6.2.2 |
| Literal header field never indexed ("sensitive") | 6.2.3 |
| Integer representation (1–8 bit prefixes, multi-byte varints) | 5.1 |
| Raw string literals | 5.2 |
| Dynamic table size updates | 4.2 / 6.3 |
| Static table (61 entries) | Appendix A |
| Entry sizing (`name + value + 32`, UTF‑8 byte lengths) and FIFO eviction | 4.1 / 4.4 |

**Huffman coding is intentionally not implemented.** A string literal
with the `H` bit set on decode, or an explicit Huffman request on encode,
raises `HuffmanUnsupportedError` (code `HUFFMAN_UNSUPPORTED`).

## Install / build / test

```bash
npm install
npm run build   # tsc -> dist/
npm test        # compiles src+test and runs node --test
```

The test suite uses only the Node.js built-in test runner
(`node:test`); the single dev dependency is TypeScript.

## Quick start

```ts
import {HpackEncoder, HpackDecoder} from 'hpack-dynamic-table-core';

// Each instance is one connection's independent state.
const enc = new HpackEncoder();
const dec = new HpackDecoder();

const wire = enc.encode([
  {name: ':method', value: 'GET'},
  {name: ':path', value: '/'},
  {name: ':scheme', value: 'https'},
  {name: ':authority', value: 'example.com'},
  // Sensitive: never-indexed, can never enter the dynamic table.
  {name: 'authorization', value: 'Bearer …', indexing: 'never'},
]);

const headers = dec.decode(wire);
// -> [{name: ':method', value: 'GET', indexing: 'indexed'}, ...]
```

### Dynamic table size updates

```ts
// Queue one or more updates (applied immediately, emitted as a prefix
// of the next block). Consecutive updates appear consecutively on wire.
enc.setTableSizeUpdate(0);
enc.setTableSizeUpdate(256);

// Or attach updates to a single block:
const block = enc.encode(headers, {tableSizeUpdates: [512, 256]});
```

`maxTableSizeLimit` corresponds to the connection's
`SETTINGS_HEADER_TABLE_SIZE` ceiling. An update above it fails
(`DYNAMIC_TABLE_SIZE`) instead of corrupting state.

### Sensitive (never-indexed) headers

Pass `indexing: 'never'`. The field is emitted with the `0001xxxx`
never-indexed literal representation and is never inserted into the
dynamic table. `indexing: 'none'` emits `0000xxxx` (without indexing) for
a one-off literal that is also not stored.

## Connection semantics and failure atomicity

- State is **per instance**: successive `encode`/`decode` calls reuse the
  same dynamic table; two encoder/decoder instances never share entries.
- Decoding a header block is **transactional**. If any representation in
  the block fails (bad index, truncation, Huffman flag, …), the dynamic
  table — entries, current size *and* capacity — is restored to exactly
  what it was before the block began. In-block size updates and
  insertions do not survive the failure.
- `encode` is likewise atomic: invalid input or an illegal queued update
  leaves the table and pending updates untouched.
- Entries evict oldest-first from the tail; an entry larger than the
  current capacity drains the table and is not inserted (Section 4.4).

## Asserting on dynamic table state

`snapshot()` returns a **detached and deeply frozen** view. Mutating the
array or any entry throws in strict mode and cannot affect internals;
every call returns fresh copies.

```ts
const snap = dec.snapshot();
snap.size;       // summed entry sizes (octets)
snap.maxSize;    // current capacity
snap.entries;    // newest first: [{name, value, size}, ...], frozen
```

## Errors

Everything thrown extends `HpackError` and carries a stable `code`:

- `HUFFMAN_UNSUPPORTED` — `HuffmanUnsupportedError`
- `INDEX_OUT_OF_RANGE`
- `TRUNCATED`
- `INTEGER_ENCODING` / `INTEGER_DECODING`
- `STRING_DECODING`
- `DYNAMIC_TABLE_SIZE`
- `ENCODING` / `DECODING` — `HpackEncodingError` / `HpackDecodingError`

The test suite includes the RFC 7541 Appendix C.3 golden vectors
(byte-exact encoder output and decoder tables for all three requests),
multi-byte integer boundaries, out-of-range indexes, consecutive size
updates, failed-block rollback, FIFO eviction order, never-indexed
handling, and multi-connection isolation.
