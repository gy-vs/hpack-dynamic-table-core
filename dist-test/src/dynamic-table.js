"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DynamicTable = exports.ENTRY_OVERHEAD = void 0;
exports.entrySize = entrySize;
const errors_1 = require("./errors");
/**
 * HPACK dynamic table (RFC 7541, Section 2.3.2).
 *
 * Entries are kept newest-first: a newly inserted entry gets dynamic
 * index 1 and the oldest entry lives at the end of the array, which is
 * also where evictions happen (Section 4.4).
 *
 * All mutating operations assign fresh arrays instead of editing the
 * entries array in place. A {@link DynamicTable.checkpoint} therefore
 * only has to capture the current references to make a later rollback
 * atomic, even when many operations happened in between.
 */
/** Per-entry overhead in octets (RFC 7541, Section 4.1). */
exports.ENTRY_OVERHEAD = 32;
/** Compute the Section 4.1 size of a prospective entry. */
function entrySize(name, value) {
    return Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8') + exports.ENTRY_OVERHEAD;
}
class DynamicTable {
    entries = [];
    _size = 0;
    _maxSize;
    /**
     * Upper bound the context negotiated for its connection (the largest
     * capacity the peer is ever allowed to request via a dynamic table
     * size update).
     */
    protocolMaxSize;
    /** Error class used for invalid sizes; encoder/decoder differ. */
    sizeErrorCtor;
    constructor(initialMaxSize = 0, protocolMaxSize, sizeErrorCtor) {
        const ErrorCtor = sizeErrorCtor ?? errors_1.HpackDecodingError;
        if (!Number.isSafeInteger(initialMaxSize) || initialMaxSize < 0) {
            throw new ErrorCtor(`invalid initial dynamic table size: ${String(initialMaxSize)}`, 'DYNAMIC_TABLE_SIZE');
        }
        const limit = protocolMaxSize ?? Number.MAX_SAFE_INTEGER;
        if (initialMaxSize > limit) {
            throw new ErrorCtor(`initial table size ${initialMaxSize} exceeds negotiated maximum ${limit}`, 'DYNAMIC_TABLE_SIZE');
        }
        this._maxSize = initialMaxSize;
        this.protocolMaxSize = limit;
        this.sizeErrorCtor = ErrorCtor;
    }
    /** Current summed entry size. */
    get size() {
        return this._size;
    }
    /** Current capacity. */
    get maxSize() {
        return this._maxSize;
    }
    /** Number of entries currently stored. */
    get length() {
        return this.entries.length;
    }
    /**
     * Look up an entry by its 1-based dynamic index.
     * Returns `undefined` when the index is out of range.
     */
    get(index) {
        if (index < 1 || index > this.entries.length) {
            return undefined;
        }
        return this.entries[index - 1];
    }
    /**
     * Change the capacity and evict oldest entries until the table fits.
     *
     * A size update larger than the connection's negotiated maximum is a
     * decoding error (RFC 7541, Section 4.2) and leaves the table untouched.
     * The new array is computed before it is installed, so eviction itself
     * cannot fail halfway.
     */
    setMaxSize(newMaxSize) {
        if (!Number.isSafeInteger(newMaxSize) ||
            newMaxSize < 0) {
            throw new this.sizeErrorCtor(`invalid dynamic table size update: ${String(newMaxSize)}`, 'DYNAMIC_TABLE_SIZE');
        }
        if (newMaxSize > this.protocolMaxSize) {
            throw new this.sizeErrorCtor(`dynamic table size update ${newMaxSize} exceeds protocol maximum ${this.protocolMaxSize}`, 'DYNAMIC_TABLE_SIZE');
        }
        let entries = this.entries;
        let size = this._size;
        if (newMaxSize < this._maxSize || size > newMaxSize) {
            let end = entries.length;
            while (size > newMaxSize && end > 0) {
                size -= entries[end - 1].size;
                end -= 1;
            }
            entries = entries.slice(0, end);
        }
        this.entries = entries;
        this._size = size;
        this._maxSize = newMaxSize;
    }
    /**
     * Insert an entry at the front, evicting oldest entries as needed.
     *
     * When the entry alone is larger than the current capacity it is not
     * inserted and the table ends up empty (RFC 7541, Section 4.4).
     */
    add(name, value) {
        const size = entrySize(name, value);
        const entry = { name, value, size };
        let end = this.entries.length;
        let remaining = this._size;
        while (remaining + size > this._maxSize && end > 0) {
            remaining -= this.entries[end - 1].size;
            end -= 1;
        }
        if (size > this._maxSize) {
            // Entry cannot fit at all; everything eligible has been evicted.
            this.entries = [];
            this._size = 0;
            return;
        }
        this.entries = [entry, ...this.entries.slice(0, end)];
        this._size = remaining + size;
    }
    /**
     * Search the table for an encoder reference.
     *
     * @returns the 1-based dynamic index of an exact name+value match, or
     *          else the index of the most recently inserted entry matching
     *          just the name, or `undefined` when the name is absent.
     */
    find(name, value) {
        let nameMatch;
        for (let i = 0; i < this.entries.length; i++) {
            const e = this.entries[i];
            if (e.name === name) {
                if (value !== undefined && e.value === value) {
                    return { index: i + 1, exact: true };
                }
                if (nameMatch === undefined) {
                    nameMatch = i + 1;
                }
            }
        }
        return nameMatch === undefined ? undefined : { index: nameMatch, exact: false };
    }
    /** Capture state so a failed header block can be rolled back. */
    checkpoint() {
        return {
            entries: this.entries,
            size: this._size,
            maxSize: this._maxSize,
        };
    }
    /** Restore a checkpoint taken with {@link checkpoint}. */
    restore(checkpoint) {
        this.entries = checkpoint.entries;
        this._size = checkpoint.size;
        this._maxSize = checkpoint.maxSize;
    }
    /**
     * Return a detached, frozen snapshot for test assertions. Mutating the
     * returned array (or any entry object) cannot affect encoder/decoder
     * state; every call allocates fresh copies.
     */
    snapshot() {
        const entries = this.entries.map(e => Object.freeze({ name: e.name, value: e.value, size: e.size }));
        return Object.freeze({
            size: this._size,
            maxSize: this._maxSize,
            entries: Object.freeze(entries),
        });
    }
}
exports.DynamicTable = DynamicTable;
