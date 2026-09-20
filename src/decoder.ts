import { DynamicTable, DynamicTableSnapshot } from "./dynamic-table.js";
import { HpackDecodingError } from "./errors.js";
import { Reader } from "./integer.js";
import { STATIC_TABLE_LENGTH, staticAt } from "./static-table.js";
import { readString } from "./string.js";

export interface DecodedHeaderField {
  readonly name: string;
  readonly value: string;
  /** True when the representation was "never-indexed" (Section 6.2.3). */
  readonly sensitive: boolean;
}

interface ResolvedEntry {
  readonly name: string;
  readonly value: string;
}

/**
 * HPACK decoder for one connection.
 *
 * Decoding a header block is transactional: if any representation is invalid,
 * the dynamic table is restored to exactly the state it had before the block
 * and no partial update survives. Successful blocks mutate the table and the
 * state is reused by subsequent blocks on this decoder.
 */
export class HpackDecoder {
  private readonly dyn: DynamicTable;

  /**
   * @param maxHeaderTableSize value of SETTINGS_HEADER_TABLE_SIZE advertised to
   *   the peer. Dynamic table size updates larger than this are an error.
   */
  constructor(private readonly maxHeaderTableSize: number = 4096) {
    this.dyn = new DynamicTable(maxHeaderTableSize);
  }

  get maxTableSize(): number {
    return this.dyn.maxSize;
  }

  /**
   * Locally change the capacity (e.g. after a new SETTINGS frame). Entries no
   * longer fitting the smaller table are evicted oldest-first.
   */
  setMaxTableSize(newSize: number): void {
    this.dyn.setMaxSize(newSize);
  }

  decode(block: Buffer): DecodedHeaderField[] {
    // Transactional copy: commit only if the whole block parses. clone() is a
    // full deep copy, so the live table cannot be left half-modified on error.
    const working = this.dyn.clone();
    const reader = new Reader(block);
    const headers: DecodedHeaderField[] = [];
    let sawField = false;

    while (reader.remaining > 0) {
      const first = reader.peekByte();

      if ((first & 0x80) !== 0) {
        // 6.1 Indexed Header Field
        const { value: index } = reader.readPrefixedInteger(7);
        if (index === 0) {
          throw new HpackDecodingError("indexed header field with index 0");
        }
        const entry = this.resolve(working, index);
        headers.push({ name: entry.name, value: entry.value, sensitive: false });
        sawField = true;
      } else if ((first & 0xc0) === 0x40) {
        // 6.2.1 Literal Header Field with Incremental Indexing
        const { value: index } = reader.readPrefixedInteger(6);
        const source = this.resolveName(working, index, reader);
        const value = readString(reader).toString("utf8");
        // Per Section 4.4 an oversized entry empties the table without error.
        working.add(source.name, value);
        headers.push({ name: source.name, value, sensitive: false });
        sawField = true;
      } else if ((first & 0xe0) === 0x20) {
        // 6.3 Dynamic Table Size Update
        if (sawField) {
          throw new HpackDecodingError(
            "dynamic table size update must precede all header fields in a block",
          );
        }
        const { value: newSize } = reader.readPrefixedInteger(5);
        if (newSize > this.maxHeaderTableSize) {
          throw new HpackDecodingError(
            `dynamic table size update ${newSize} exceeds limit ${this.maxHeaderTableSize}`,
          );
        }
        working.setMaxSize(newSize);
      } else if ((first & 0xf0) === 0x10) {
        // 6.2.3 Literal Header Field Never Indexed — sensitive, never tabulated.
        const { value: index } = reader.readPrefixedInteger(4);
        const source = this.resolveName(working, index, reader);
        const value = readString(reader).toString("utf8");
        headers.push({ name: source.name, value, sensitive: true });
        sawField = true;
      } else {
        // 6.2.2 Literal Header Field Without Indexing (top 4 bits all zero)
        const { value: index } = reader.readPrefixedInteger(4);
        const source = this.resolveName(working, index, reader);
        const value = readString(reader).toString("utf8");
        headers.push({ name: source.name, value, sensitive: false });
        sawField = true;
      }
    }

    // Commit. restoreFrom deep-copies from the working table, so later decoder
    // state stays independent of the discarded scratch copy.
    this.dyn.restoreFrom(working);
    return headers;
  }

  /** Resolve a 1-based index against static then dynamic table. */
  private resolve(table: DynamicTable, index: number): ResolvedEntry {
    if (index <= STATIC_TABLE_LENGTH) {
      const entry = staticAt(index);
      if (entry === undefined) {
        throw new HpackDecodingError(`static table index ${index} is out of range`);
      }
      return entry;
    }
    const dynIndex = index - STATIC_TABLE_LENGTH;
    const entry = table.dynamicAt(dynIndex);
    if (entry === undefined) {
      throw new HpackDecodingError(`dynamic table index ${index} is out of range`);
    }
    return entry;
  }

  /** Resolve the name of a literal representation; index 0 carries a name literal. */
  private resolveName(table: DynamicTable, index: number, reader: Reader): { name: string } {
    if (index === 0) {
      return { name: readString(reader).toString("utf8") };
    }
    return this.resolve(table, index);
  }

  /** Deep snapshot of the dynamic table for test assertions. */
  snapshot(): DynamicTableSnapshot {
    return this.dyn.snapshot();
  }
}
