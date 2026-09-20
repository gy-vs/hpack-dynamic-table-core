"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.HuffmanUnsupportedError = exports.HpackDecodingError = exports.HpackEncodingError = exports.HpackError = exports.decodeString = exports.encodeString = exports.decodeInteger = exports.encodeInteger = exports.getStaticEntry = exports.STATIC_TABLE_LENGTH = exports.entrySize = exports.ENTRY_OVERHEAD = exports.DynamicTable = exports.MAX_HEADER_TABLE_SIZE = exports.HpackDecoder = exports.HpackEncoder = void 0;
var encoder_1 = require("./encoder");
Object.defineProperty(exports, "HpackEncoder", { enumerable: true, get: function () { return encoder_1.HpackEncoder; } });
var decoder_1 = require("./decoder");
Object.defineProperty(exports, "HpackDecoder", { enumerable: true, get: function () { return decoder_1.HpackDecoder; } });
Object.defineProperty(exports, "MAX_HEADER_TABLE_SIZE", { enumerable: true, get: function () { return decoder_1.MAX_HEADER_TABLE_SIZE; } });
var dynamic_table_1 = require("./dynamic-table");
Object.defineProperty(exports, "DynamicTable", { enumerable: true, get: function () { return dynamic_table_1.DynamicTable; } });
Object.defineProperty(exports, "ENTRY_OVERHEAD", { enumerable: true, get: function () { return dynamic_table_1.ENTRY_OVERHEAD; } });
Object.defineProperty(exports, "entrySize", { enumerable: true, get: function () { return dynamic_table_1.entrySize; } });
var static_table_1 = require("./static-table");
Object.defineProperty(exports, "STATIC_TABLE_LENGTH", { enumerable: true, get: function () { return static_table_1.STATIC_TABLE_LENGTH; } });
Object.defineProperty(exports, "getStaticEntry", { enumerable: true, get: function () { return static_table_1.getStaticEntry; } });
var integer_1 = require("./integer");
Object.defineProperty(exports, "encodeInteger", { enumerable: true, get: function () { return integer_1.encodeInteger; } });
Object.defineProperty(exports, "decodeInteger", { enumerable: true, get: function () { return integer_1.decodeInteger; } });
var string_literal_1 = require("./string-literal");
Object.defineProperty(exports, "encodeString", { enumerable: true, get: function () { return string_literal_1.encodeString; } });
Object.defineProperty(exports, "decodeString", { enumerable: true, get: function () { return string_literal_1.decodeString; } });
var errors_1 = require("./errors");
Object.defineProperty(exports, "HpackError", { enumerable: true, get: function () { return errors_1.HpackError; } });
Object.defineProperty(exports, "HpackEncodingError", { enumerable: true, get: function () { return errors_1.HpackEncodingError; } });
Object.defineProperty(exports, "HpackDecodingError", { enumerable: true, get: function () { return errors_1.HpackDecodingError; } });
Object.defineProperty(exports, "HuffmanUnsupportedError", { enumerable: true, get: function () { return errors_1.HuffmanUnsupportedError; } });
