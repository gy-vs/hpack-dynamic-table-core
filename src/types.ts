/**
 * Shared HPACK types.
 */

/**
 * Indexing policy for a literal header field (RFC 7541, Sections 6.2.x).
 *
 * - `indexed`:  literal with incremental indexing (6.2.1); the entry is
 *               inserted into the dynamic table.
 * - `none`:     literal without indexing (6.2.2); emitted for this block
 *               only, never stored.
 * - `never`:    literal never indexed (6.2.3); marks the field as
 *               sensitive. Never stored and forwarded as never-indexed.
 */
export type IndexingMode = 'indexed' | 'none' | 'never';

/** A decoded header field. */
export interface HeaderField {
  name: string;
  value: string;
  /**
   * Indexing mode seen on the wire. Indexed representations decode as
   * `indexed`; size updates never appear here.
   */
  indexing: IndexingMode;
}

/** A header field to encode. */
export interface HeaderInput {
  name: string;
  value: string;
  /** Defaults to `indexed`. Use `never` for sensitive headers. */
  indexing?: IndexingMode;
}

/** Constructor options shared by encoder and decoder. */
export interface HpackContextOptions {
  /**
   * Initial dynamic table capacity (octets). The table itself starts
   * empty. Defaults to 4096 (the HTTP/2 default).
   */
  initialMaxTableSize?: number;
  /**
   * Largest dynamic table size the peer is allowed to request (the
   * SETTINGS_HEADER_TABLE_SIZE limit, RFC 7541, Section 4.2).
   * Defaults to the initial size for encoders (a server must not shrink
   * below what its own setting permits) and to 2^32-1 for decoders.
   */
  maxTableSizeLimit?: number;
}
