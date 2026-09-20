import { DynamicTable, DynamicTableSnapshot } from "./dynamic-table.js";
import { HpackError } from "./errors.js";
import { encodeInteger } from "./integer.js";
import { findStaticExact, findStaticName } from "./static-table.js";
import { encodeString } from "./string.js";

export type IndexingMode = "indexed" | "none" | "never";

export interface HeaderField {
  readonly name: string;
  readonly value: string;
  /**
   * How the field may be indexed:
   *  - "indexed": encode with incremental indexing, may enter the dynamic table
   *  - "none":    literal without indexing, never enters the table
   *  - "never":   literal never-indexed (sensitive data); never enters the table
   */
  readonly indexing?: IndexingMode;
}

/**
 * HPACK encoder for one connection. Maintains its own dynamic table; distinct
 * encoder instances never share state.
 */
export class HpackEncoder {
  private readonly dyn: DynamicTable;
  /** Pending dynamic table size updates, emitted before the next block. */
  private pendingSizeUpdates: number[] = [];

  constructor(private readonly initialMaxSize: number = 4096) {
    this.dyn = new DynamicTable(initialMaxSize);
  }

  /** Current protocol maximum the encoder was last told it may use. */
  get maxTableSize(): number {
    return this.dyn.maxSize;
  }

  /**
   * Acknowledge a SETTINGS_HEADER_TABLE_SIZE change / enqueue a dynamic table
   * size update (Section 6.3). Updates are emitted at the start of the next
   * encoded block, in request order. Each update must not exceed the largest
   * capacity given to the constructor.
   */
  updateTableSize(newSize: number): void {
    if (newSize > this.initialMaxSize) {
      throw new HpackError(
        `cannot request dynamic table size ${newSize}: advertised limit is ${this.initialMaxSize}`,
      );
    }
    this.pendingSizeUpdates.push(newSize);
    this.dyn.setMaxSize(newSize);
  }

  /**
   * Encode one header block. Dynamic table mutations persist for subsequent
   * blocks on this encoder.
   */
  encode(headers: Iterable<HeaderField>): Buffer {
    const parts: Buffer[] = [];

    for (const newSize of this.pendingSizeUpdates) {
      parts.push(encodeInteger(newSize, 5, 0x20));
    }
    this.pendingSizeUpdates = [];

    for (const header of headers) {
      parts.push(this.encodeField(header));
    }
    return Buffer.concat(parts);
  }

  private encodeField(header: HeaderField): Buffer {
    const mode: IndexingMode = header.indexing ?? "indexed";

    if (mode === "never") {
      return this.encodeLiteral(header, 0x10, 4);
    }
    if (mode === "none") {
      return this.encodeLiteral(header, 0x00, 4);
    }

    // Incremental indexing: an exact static/dynamic match can be emitted as an
    // indexed representation (Section 6.1) instead of inserting a duplicate.
    const exact = this.findExact(header.name, header.value);
    if (exact !== 0) {
      return encodeInteger(exact, 7, 0x80);
    }

    const encoded = this.encodeLiteral(header, 0x40, 6);

    // Insert into the local dynamic table, evicting per Section 4.4.
    this.dyn.add(header.name, header.value);
    return encoded;
  }

  private encodeLiteral(header: HeaderField, highBits: number, prefixBits: number): Buffer {
    const nameIndex = this.findName(header.name);
    const parts: Buffer[] = [];
    if (nameIndex !== 0) {
      parts.push(encodeInteger(nameIndex, prefixBits, highBits));
    } else {
      parts.push(encodeInteger(0, prefixBits, highBits));
      parts.push(encodeString(header.name));
    }
    parts.push(encodeString(header.value));
    return Buffer.concat(parts);
  }

  /** Exact match across dynamic then static table; 0 means no match. */
  private findExact(name: string, value: string): number {
    const dynIndex = this.dyn.findExact(name, value);
    if (dynIndex !== 0) {
      return dynIndex;
    }
    return findStaticExact(name, value);
  }

  /** Name-only match: dynamic table first (as required), then static table. */
  private findName(name: string): number {
    const dynIndex = this.dyn.findName(name);
    if (dynIndex !== 0) {
      return dynIndex;
    }
    return findStaticName(name);
  }

  /** Deep snapshot of the dynamic table for test assertions. */
  snapshot(): DynamicTableSnapshot {
    return this.dyn.snapshot();
  }
}
