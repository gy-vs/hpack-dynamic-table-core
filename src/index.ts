/**
 * HPACK subset (RFC 7541) for encoding/decoding HTTP/2 header blocks in
 * test environments.
 *
 * Supported:
 *  - indexed header fields (static + dynamic tables)
 *  - literal fields with incremental indexing / without indexing /
 *    never indexed
 *  - integer representation (1..8 bit prefixes, multi-byte varints)
 *  - raw string literals and dynamic table size updates
 *  - connection-scoped dynamic tables with RFC entry sizing/eviction
 *
 * Not supported:
 *  - Huffman coding (an H bit on decode or an explicit request on encode
 *    throws {@link HuffmanUnsupportedError}).
 */

export {HpackEncoder, EncodeOptions} from './encoder';
export {HpackDecoder, MAX_HEADER_TABLE_SIZE} from './decoder';
export {
  DynamicTable,
  DynamicTableSnapshot,
  DynamicEntry,
  ENTRY_OVERHEAD,
  entrySize,
} from './dynamic-table';
export {
  STATIC_TABLE_LENGTH,
  getStaticEntry,
  StaticEntry,
} from './static-table';
export {encodeInteger, decodeInteger, DecodedInteger} from './integer';
export {encodeString, decodeString, DecodedString} from './string-literal';
export {
  HeaderField,
  HeaderInput,
  IndexingMode,
  HpackContextOptions,
} from './types';
export {
  HpackError,
  HpackEncodingError,
  HpackDecodingError,
  HuffmanUnsupportedError,
  HpackErrorCode,
} from './errors';
