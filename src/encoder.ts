import {DynamicTable, DynamicTableSnapshot} from './dynamic-table';
import {HuffmanUnsupportedError, HpackEncodingError} from './errors';
import {encodeInteger} from './integer';
import {encodeString} from './string-literal';
import {findStaticEntry, STATIC_TABLE_LENGTH} from './static-table';
import {HeaderInput, HpackContextOptions, IndexingMode} from './types';

export interface EncodeOptions {
  /**
   * Emit dynamic table size update(s) at the start of this block in
   * addition to any updates already queued (RFC 7541, Section 6.3).
   * Values are emitted in order; each changes the table capacity.
   */
  tableSizeUpdates?: number[];
}

/**
 * HPACK encoder for a single HTTP/2 connection.
 *
 * Each instance owns its own dynamic table; state persists across
 * successive calls to {@link encode} but never crosses instances.
 */
export class HpackEncoder {
  private readonly dynamicTable: DynamicTable;
  /**
   * Pending dynamic table size updates (octets). Each call to
   * {@link encode} emits them at the start of the block and clears the
   * queue, so consecutive updates are observable as separate prefixes.
   */
  private pendingSizeUpdates: number[] = [];

  constructor(options: HpackContextOptions = {}) {
    const initial = options.initialMaxTableSize ?? 4096;
    const limit = options.maxTableSizeLimit ?? 0xffffffff;
    if (initial > limit) {
      throw new HpackEncodingError(
        `initial table size ${initial} exceeds negotiated maximum ${limit}`,
        'DYNAMIC_TABLE_SIZE'
      );
    }
    this.dynamicTable = new DynamicTable(initial, limit, HpackEncodingError);
  }

  /**
   * Queue a dynamic table size update (RFC 7541, Section 6.3).
   *
   * The capacity takes effect immediately, including evictions; the wire
   * representation is emitted at the beginning of the next encoded block.
   * Several queued updates therefore appear consecutively on the wire.
   */
  setTableSizeUpdate(size: number): void {
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
  encode(headers: Iterable<HeaderInput>, options: EncodeOptions = {}): Buffer {
    // Validate the whole input before touching any state, so an invalid
    // header halfway through an iterable cannot leave a half-encoded
    // dynamic table or a cleared update queue behind.
    const headerList = [...headers];
    for (const header of headerList) {
      this.validateHeader(header);
    }

    const chunks: Buffer[] = [];
    const tableCheckpoint = this.dynamicTable.checkpoint();
    const queuedUpdates = this.pendingSizeUpdates;

    try {
      const emitUpdate = (size: number): void => {
        this.dynamicTable.setMaxSize(size);
        // 001xxxxx with the 5-bit prefix (Section 6.3).
        chunks.push(encodeInteger(0x20, 5, size));
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
    } catch (err) {
      // Restore the table and re-arm queued updates: a failed encode has
      // no observable side effect on connection state.
      this.dynamicTable.restore(tableCheckpoint);
      this.pendingSizeUpdates = queuedUpdates;
      throw err;
    }

    this.pendingSizeUpdates = [];
    return Buffer.concat(chunks);
  }

  private validateHeader(header: HeaderInput): void {
    if (typeof header.name !== 'string' || header.name.length === 0) {
      throw new HpackEncodingError('header name must be a non-empty string');
    }
    if (typeof header.value !== 'string') {
      throw new HpackEncodingError('header value must be a string');
    }
    const indexing: IndexingMode | undefined = header.indexing;
    if (
      indexing !== undefined &&
      indexing !== 'indexed' &&
      indexing !== 'none' &&
      indexing !== 'never'
    ) {
      throw new HpackEncodingError(`unknown indexing mode: ${String(indexing)}`);
    }
  }

  private encodeHeader(header: HeaderInput): Buffer {
    const {name, value} = header;
    const mode: IndexingMode = header.indexing ?? 'indexed';

    if (mode === 'indexed') {
      // 6.1: a full name+value match in either table is an indexed field.
      const dynamicMatch = this.dynamicTable.find(name, value);
      if (dynamicMatch?.exact) {
        // Dynamic indexes follow the 61 static entries.
        return encodeInteger(0x80, 7, STATIC_TABLE_LENGTH + dynamicMatch.index);
      }
      const staticMatch = findStaticEntry(name, value);
      if (staticMatch?.exact) {
        return encodeInteger(0x80, 7, staticMatch.index);
      }

      // 6.2.1: literal with incremental indexing; insert afterwards.
      const literal = this.encodeLiteralName(0x40, 6, name);
      const out = Buffer.concat([literal, encodeString(value)]);
      this.dynamicTable.add(name, value);
      return out;
    }

    // 6.2.2 (without indexing) and 6.2.3 (never indexed) share the body;
    // they never insert into the dynamic table.
    const firstByte = mode === 'never' ? 0x10 : 0x00;
    const literal = this.encodeLiteralName(firstByte, 4, name);
    return Buffer.concat([literal, encodeString(value)]);
  }

  /**
   * Emit the name portion of a literal header field, reusing a name
   * reference from the dynamic table (preferred) or the static table.
   * Falls back to a literal name when the name appears in neither.
   */
  private encodeLiteralName(
    firstByte: number,
    prefixBits: number,
    name: string
  ): Buffer {
    const dynamicName = this.dynamicTable.find(name);
    if (dynamicName !== undefined) {
      return encodeInteger(
        firstByte,
        prefixBits,
        STATIC_TABLE_LENGTH + dynamicName.index
      );
    }
    const staticName = findStaticEntry(name);
    if (staticName !== undefined) {
      return encodeInteger(firstByte, prefixBits, staticName.index);
    }
    return Buffer.concat([
      encodeInteger(firstByte, prefixBits, 0),
      encodeString(name),
    ]);
  }

  /** Current dynamic table capacity (octets). */
  get maxTableSize(): number {
    return this.dynamicTable.maxSize;
  }

  /** Current summed size of dynamic entries (octets). */
  get tableSize(): number {
    return this.dynamicTable.size;
  }

  /** Number of dynamic entries. */
  get tableLength(): number {
    return this.dynamicTable.length;
  }

  /**
   * Detached, read-only snapshot of the dynamic table for assertions.
   * The returned object cannot be used to mutate encoder state.
   */
  snapshot(): DynamicTableSnapshot {
    return this.dynamicTable.snapshot();
  }

  /**
   * Explicitly request Huffman coding — always fails in this subset,
   * giving callers a defined error instead of silently ignoring intent.
   */
  setHuffmanEnabled(enabled: boolean): void {
    if (enabled) {
      throw new HuffmanUnsupportedError('encode');
    }
  }
}
