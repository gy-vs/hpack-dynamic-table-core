import { STATIC_TABLE_LENGTH } from "./static-table.js";

/** Per-entry overhead added to name + value byte length (RFC 7541, Section 4.1). */
export const ENTRY_OVERHEAD = 32;

export interface DynamicEntry {
  readonly name: string;
  readonly value: string;
}

/** Immutable view of a dynamic table, suitable for test assertions. */
export interface DynamicTableSnapshot {
  /** Entries in insertion order (newest entry is at the end). */
  readonly entries: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  /** Sum of the RFC 7541 sizes of all current entries. */
  readonly size: number;
  /** Current protocol-level maximum table size. */
  readonly maxSize: number;
  /** Total number of entries ever inserted, including those later evicted. */
  readonly insertCount: number;
}

/**
 * The per-connection dynamic table (RFC 7541, Section 2.3.2).
 *
 * Entries are stored newest-first, matching the wire index order: wire index
 * `len(static) + 1` refers to the most recently inserted entry.
 */
export class DynamicTable {
  private table: DynamicEntry[] = [];
  private _size = 0;
  private _insertCount = 0;

  constructor(private _maxSize: number = 4096) {
    if (!Number.isInteger(_maxSize) || _maxSize < 0) {
      throw new RangeError(`maxSize must be a non-negative integer, got ${_maxSize}`);
    }
  }

  get size(): number {
    return this._size;
  }

  get maxSize(): number {
    return this._maxSize;
  }

  get length(): number {
    return this.table.length;
  }

  get insertCount(): number {
    return this._insertCount;
  }

  /** Size of a hypothetical entry (Section 4.1). */
  static entrySize(name: string, value: string): number {
    return Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + ENTRY_OVERHEAD;
  }

  /**
   * Add an entry, evicting older entries as necessary (Section 4.3/4.4).
   *
   * Per Section 4.4 an entry larger than the maximum size empties the table
   * and is *not* inserted; that is legal on the decoder. Returns whether the
   * entry was actually inserted.
   */
  add(name: string, value: string): boolean {
    const entrySize = DynamicTable.entrySize(name, value);
    while (this._size + entrySize > this._maxSize && this.table.length > 0) {
      this.evictOldest();
    }
    if (entrySize > this._maxSize) {
      return false;
    }
    this.table.unshift({ name, value });
    this._size += entrySize;
    this._insertCount += 1;
    return true;
  }

  private evictOldest(): void {
    const oldest = this.table.pop();
    if (oldest === undefined) {
      return;
    }
    this._size -= DynamicTable.entrySize(oldest.name, oldest.value);
  }

  /**
   * Resize the table (Section 4.3). Entries are evicted oldest-first until the
   * table fits the new limit.
   */
  setMaxSize(newMax: number): void {
    if (!Number.isInteger(newMax) || newMax < 0) {
      throw new RangeError(`table size must be a non-negative integer, got ${newMax}`);
    }
    this._maxSize = newMax;
    while (this._size > this._maxSize && this.table.length > 0) {
      this.evictOldest();
    }
  }

  /**
   * Look up a 1-based *dynamic* wire index (i.e. index minus static length).
   * Index 1 is the newest entry.
   */
  dynamicAt(dynamicIndex1: number): DynamicEntry | undefined {
    if (dynamicIndex1 < 1 || dynamicIndex1 > this.table.length) {
      return undefined;
    }
    return this.table[dynamicIndex1 - 1];
  }

  /** Exact (name + value) match; returns 0 when nothing matches. */
  findExact(name: string, value: string): number {
    for (let i = 0; i < this.table.length; i++) {
      const entry = this.table[i]!;
      if (entry.name === name && entry.value === value) {
        return STATIC_TABLE_LENGTH + i + 1;
      }
    }
    return 0;
  }

  /** Name-only match; returns 0 when no entry has that name. */
  findName(name: string): number {
    for (let i = 0; i < this.table.length; i++) {
      if (this.table[i]!.name === name) {
        return STATIC_TABLE_LENGTH + i + 1;
      }
    }
    return 0;
  }

  /** Deep, detached copy used for transactional decode rollback. */
  clone(): DynamicTable {
    const copy = new DynamicTable(this._maxSize);
    copy.table = this.table.map((entry) => ({ ...entry }));
    copy._size = this._size;
    copy._insertCount = this._insertCount;
    return copy;
  }

  /** Restore state previously captured with {@link clone}. */
  restoreFrom(other: DynamicTable): void {
    this.table = other.table.map((entry) => ({ ...entry }));
    this._size = other._size;
    this._maxSize = other._maxSize;
    this._insertCount = other._insertCount;
  }

  /**
   * Return a deep snapshot for assertions. The returned value shares no
   * references with internal state, so callers cannot mutate the table.
   */
  snapshot(): DynamicTableSnapshot {
    return {
      entries: this.table
        .slice()
        .reverse()
        .map((entry) => ({ name: entry.name, value: entry.value })),
      size: this._size,
      maxSize: this._maxSize,
      insertCount: this._insertCount,
    };
  }
}
