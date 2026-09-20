"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HpackEncoder = void 0;
const dynamic_table_1 = require("./dynamic-table");
const errors_1 = require("./errors");
const integer_1 = require("./integer");
const string_literal_1 = require("./string-literal");
const static_table_1 = require("./static-table");
/**
 * HPACK encoder for a single HTTP/2 connection.
 *
 * Each instance owns its own dynamic table; state persists across
 * successive calls to {@link encode} but never crosses instances.
 */
class HpackEncoder {
    dynamicTable;
    /**
     * Pending dynamic table size updates (octets). Each call to
     * {@link encode} emits them at the start of the block and clears the
     * queue, so consecutive updates are observable as separate prefixes.
     */
    pendingSizeUpdates = [];
    constructor(options = {}) {
        const initial = options.initialMaxTableSize ?? 4096;
        const limit = options.maxTableSizeLimit ?? 0xffffffff;
        if (initial > limit) {
            throw new errors_1.HpackEncodingError(`initial table size ${initial} exceeds negotiated maximum ${limit}`, 'DYNAMIC_TABLE_SIZE');
        }
        this.dynamicTable = new dynamic_table_1.DynamicTable(initial, limit, errors_1.HpackEncodingError);
    }
    /**
     * Queue a dynamic table size update (RFC 7541, Section 6.3).
     *
     * The capacity takes effect immediately, including evictions; the wire
     * representation is emitted at the beginning of the next encoded block.
     * Several queued updates therefore appear consecutively on the wire.
     */
    setTableSizeUpdate(size) {
        // Applies and validates (including the protocol maximum) up front so
        // that illegal requests fail before any block is encoded.
        this.dynamicTable.setMaxSize(size);
        this.pendingSizeUpdates.push(size);
    }
    /**
     * Encode one header block.
     *
     * @param headers Header fields in emission order. Fields whose
     *                `indexing` is `never` are treated as sensitive: they
     *                are sent as literal never-indexed and never enter the
     *                dynamic table.
     * @param options Optional per-block table size updates.
     */
    encode(headers, options = {}) {
        // Validate the whole input before touching any state, so an invalid
        // header halfway through an iterable cannot leave a half-encoded
        // dynamic table or a cleared update queue behind.
        const headerList = [...headers];
        for (const header of headerList) {
            this.validateHeader(header);
        }
        const chunks = [];
        const tableCheckpoint = this.dynamicTable.checkpoint();
        const queuedUpdates = this.pendingSizeUpdates;
        try {
            const emitUpdate = (size) => {
                this.dynamicTable.setMaxSize(size);
                // 001xxxxx with the 5-bit prefix (Section 6.3).
                chunks.push((0, integer_1.encodeInteger)(0x20, 5, size));
            };
            // Updates queued via setTableSizeUpdate are emitted once, in order,
            // at the start of the next block.
            for (const size of queuedUpdates) {
                emitUpdate(size);
            }
            // Per-call updates are emitted as consecutive prefixes on this block
            // only; they are not re-emitted on the following block.
            for (const size of options.tableSizeUpdates ?? []) {
                emitUpdate(size);
            }
            for (const header of headerList) {
                chunks.push(this.encodeHeader(header));
            }
        }
        catch (err) {
            // Restore the table and re-arm queued updates: a failed encode has
            // no observable side effect on connection state.
            this.dynamicTable.restore(tableCheckpoint);
            this.pendingSizeUpdates = queuedUpdates;
            throw err;
        }
        this.pendingSizeUpdates = [];
        return Buffer.concat(chunks);
    }
    validateHeader(header) {
        if (typeof header.name !== 'string' || header.name.length === 0) {
            throw new errors_1.HpackEncodingError('header name must be a non-empty string');
        }
        if (typeof header.value !== 'string') {
            throw new errors_1.HpackEncodingError('header value must be a string');
        }
        const indexing = header.indexing;
        if (indexing !== undefined &&
            indexing !== 'indexed' &&
            indexing !== 'none' &&
            indexing !== 'never') {
            throw new errors_1.HpackEncodingError(`unknown indexing mode: ${String(indexing)}`);
        }
    }
    encodeHeader(header) {
        const { name, value } = header;
        const mode = header.indexing ?? 'indexed';
        if (mode === 'indexed') {
            // 6.1: a full name+value match in either table is an indexed field.
            const dynamicMatch = this.dynamicTable.find(name, value);
            if (dynamicMatch?.exact) {
                // Dynamic indexes follow the 61 static entries.
                return (0, integer_1.encodeInteger)(0x80, 7, static_table_1.STATIC_TABLE_LENGTH + dynamicMatch.index);
            }
            const staticMatch = (0, static_table_1.findStaticEntry)(name, value);
            if (staticMatch?.exact) {
                return (0, integer_1.encodeInteger)(0x80, 7, staticMatch.index);
            }
            // 6.2.1: literal with incremental indexing; insert afterwards.
            const literal = this.encodeLiteralName(0x40, 6, name);
            const out = Buffer.concat([literal, (0, string_literal_1.encodeString)(value)]);
            this.dynamicTable.add(name, value);
            return out;
        }
        // 6.2.2 (without indexing) and 6.2.3 (never indexed) share the body;
        // they never insert into the dynamic table.
        const firstByte = mode === 'never' ? 0x10 : 0x00;
        const literal = this.encodeLiteralName(firstByte, 4, name);
        return Buffer.concat([literal, (0, string_literal_1.encodeString)(value)]);
    }
    /**
     * Emit the name portion of a literal header field, reusing a name
     * reference from the dynamic table (preferred) or the static table.
     * Falls back to a literal name when the name appears in neither.
     */
    encodeLiteralName(firstByte, prefixBits, name) {
        const dynamicName = this.dynamicTable.find(name);
        if (dynamicName !== undefined) {
            return (0, integer_1.encodeInteger)(firstByte, prefixBits, static_table_1.STATIC_TABLE_LENGTH + dynamicName.index);
        }
        const staticName = (0, static_table_1.findStaticEntry)(name);
        if (staticName !== undefined) {
            return (0, integer_1.encodeInteger)(firstByte, prefixBits, staticName.index);
        }
        return Buffer.concat([
            (0, integer_1.encodeInteger)(firstByte, prefixBits, 0),
            (0, string_literal_1.encodeString)(name),
        ]);
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
     * The returned object cannot be used to mutate encoder state.
     */
    snapshot() {
        return this.dynamicTable.snapshot();
    }
    /**
     * Explicitly request Huffman coding — always fails in this subset,
     * giving callers a defined error instead of silently ignoring intent.
     */
    setHuffmanEnabled(enabled) {
        if (enabled) {
            throw new errors_1.HuffmanUnsupportedError('encode');
        }
    }
}
exports.HpackEncoder = HpackEncoder;
