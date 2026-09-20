"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HpackDecoder = exports.MAX_HEADER_TABLE_SIZE = void 0;
const dynamic_table_1 = require("./dynamic-table");
const errors_1 = require("./errors");
const integer_1 = require("./integer");
const string_literal_1 = require("./string-literal");
const static_table_1 = require("./static-table");
/** Protocol maximum for HPACK dynamic table sizes (RFC 7541, Section 4.2). */
exports.MAX_HEADER_TABLE_SIZE = 0xffffffff;
/**
 * HPACK decoder for a single HTTP/2 connection.
 *
 * State (the dynamic table) persists across successive header blocks of
 * the connection and is never shared with another instance. A block that
 * fails to decode is rolled back: the dynamic table ends the failed
 * block exactly as it entered it.
 */
class HpackDecoder {
    dynamicTable;
    constructor(options = {}) {
        const initial = options.initialMaxTableSize ?? 4096;
        const limit = options.maxTableSizeLimit ?? exports.MAX_HEADER_TABLE_SIZE;
        if (initial > limit) {
            throw new errors_1.HpackDecodingError(`initial table size ${initial} exceeds negotiated maximum ${limit}`, 'DYNAMIC_TABLE_SIZE');
        }
        this.dynamicTable = new dynamic_table_1.DynamicTable(initial, limit);
    }
    /**
     * Decode one HTTP/2 HEADERS/CONTINUATION payload (one header block
     * fragment sequence assembled by the caller).
     *
     * @throws HpackDecodingError (or HuffmanUnsupportedError) when the
     *         block is malformed. In that case the dynamic table is
     *         restored to the state it had before this call.
     */
    decode(block) {
        const checkpoint = this.dynamicTable.checkpoint();
        const headers = [];
        let offset = 0;
        // Dynamic table size updates are only legal before any header field
        // representation of the block (RFC 7541, Section 4.2).
        let seenHeaderField = false;
        try {
            while (offset < block.length) {
                const first = block[offset];
                // 1xxxxxxx: indexed header field (6.1)
                if (first & 0x80) {
                    const { value: index, length } = (0, integer_1.decodeInteger)(block, offset, 7);
                    offset += length;
                    const entry = this.lookup(index);
                    headers.push({ name: entry.name, value: entry.value, indexing: 'indexed' });
                    seenHeaderField = true;
                    continue;
                }
                // 01xxxxxx: literal with incremental indexing (6.2.1)
                if (first & 0x40) {
                    const name = this.readName(block, offset, 6);
                    offset = name.nextOffset;
                    const value = (0, string_literal_1.decodeString)(block, offset);
                    offset += value.length;
                    this.dynamicTable.add(name.name, value.value);
                    headers.push({ name: name.name, value: value.value, indexing: 'indexed' });
                    seenHeaderField = true;
                    continue;
                }
                // 001xxxxx: dynamic table size update (6.3)
                if (first & 0x20) {
                    if (seenHeaderField) {
                        throw new errors_1.HpackDecodingError('dynamic table size update after a header field representation', 'DECODING');
                    }
                    const { value: newSize, length } = (0, integer_1.decodeInteger)(block, offset, 5);
                    offset += length;
                    // setMaxSize throws when the value exceeds the negotiated limit;
                    // the enclosing rollback keeps any earlier in-block updates
                    // from surviving the failure.
                    this.dynamicTable.setMaxSize(newSize);
                    continue;
                }
                // 0000xxxx: literal without indexing (6.2.2)
                // 0001xxxx: literal never indexed (6.2.3)
                // Top nibbles 0000 / 0001 share the same body layout; bit 4
                // distinguishes them (0 = without indexing, 1 = never indexed).
                const mode = first & 0x10 ? 'never' : 'none';
                const name = this.readName(block, offset, 4);
                offset = name.nextOffset;
                const value = (0, string_literal_1.decodeString)(block, offset);
                offset += value.length;
                // Per Sections 6.2.2/6.2.3 neither representation touches the
                // dynamic table, so sensitive fields can never be stored.
                headers.push({ name: name.name, value: value.value, indexing: mode });
                seenHeaderField = true;
            }
        }
        catch (err) {
            this.dynamicTable.restore(checkpoint);
            throw err;
        }
        return headers;
    }
    /** Resolve an indexed reference against static then dynamic table. */
    lookup(index) {
        if (index === 0) {
            throw new errors_1.HpackDecodingError('indexed representation with index 0', 'INDEX_OUT_OF_RANGE');
        }
        const staticEntry = (0, static_table_1.getStaticEntry)(index);
        if (staticEntry !== undefined) {
            return staticEntry;
        }
        const dynamicIndex = index - static_table_1.STATIC_TABLE_LENGTH;
        const dynamicEntry = this.dynamicTable.get(dynamicIndex);
        if (dynamicEntry === undefined) {
            throw new errors_1.HpackDecodingError(`index ${index} out of range (dynamic table has ${this.dynamicTable.length} entries)`, 'INDEX_OUT_OF_RANGE');
        }
        return dynamicEntry;
    }
    readName(block, offset, prefixBits) {
        const { value: nameIndex, length } = (0, integer_1.decodeInteger)(block, offset, prefixBits);
        let nextOffset = offset + length;
        if (nameIndex === 0) {
            const name = (0, string_literal_1.decodeString)(block, nextOffset);
            nextOffset += name.length;
            return { name: name.value, nextOffset };
        }
        const entry = this.lookup(nameIndex);
        return { name: entry.name, nextOffset };
    }
    /** Current dynamic table capacity (octets). */
    get maxTableSize() {
        return this.dynamicTable.maxSize;
    }
    /** Current summed size of dynamic entries (octets). */
    get tableSize() {
        return this.dynamicTable.size;
    }
    /** Number of dynamic entries. */
    get tableLength() {
        return this.dynamicTable.length;
    }
    /**
     * Detached, read-only snapshot of the dynamic table for assertions.
     * The returned object cannot be used to mutate decoder state.
     */
    snapshot() {
        return this.dynamicTable.snapshot();
    }
}
exports.HpackDecoder = HpackDecoder;
