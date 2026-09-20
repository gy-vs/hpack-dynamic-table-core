"use strict";
/**
 * HPACK static table (RFC 7541, Appendix A).
 *
 * Index 0 is unused; static entries occupy indexes 1..61.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STATIC_TABLE_LENGTH = void 0;
exports.getStaticEntry = getStaticEntry;
exports.findStaticEntry = findStaticEntry;
const STATIC_TABLE = [
    // index 0 is never used; keep the array index aligned with the HPACK index.
    { name: '', value: '' },
    { name: ':authority', value: '' },
    { name: ':method', value: 'GET' },
    { name: ':method', value: 'POST' },
    { name: ':path', value: '/' },
    { name: ':path', value: '/index.html' },
    { name: ':scheme', value: 'http' },
    { name: ':scheme', value: 'https' },
    { name: ':status', value: '200' },
    { name: ':status', value: '204' },
    { name: ':status', value: '206' },
    { name: ':status', value: '304' },
    { name: ':status', value: '400' },
    { name: ':status', value: '404' },
    { name: ':status', value: '500' },
    { name: 'accept-charset', value: '' },
    { name: 'accept-encoding', value: 'gzip, deflate' },
    { name: 'accept-language', value: '' },
    { name: 'accept-ranges', value: '' },
    { name: 'accept', value: '' },
    { name: 'access-control-allow-origin', value: '' },
    { name: 'age', value: '' },
    { name: 'allow', value: '' },
    { name: 'authorization', value: '' },
    { name: 'cache-control', value: '' },
    { name: 'content-disposition', value: '' },
    { name: 'content-encoding', value: '' },
    { name: 'content-language', value: '' },
    { name: 'content-length', value: '' },
    { name: 'content-location', value: '' },
    { name: 'content-range', value: '' },
    { name: 'content-type', value: '' },
    { name: 'cookie', value: '' },
    { name: 'date', value: '' },
    { name: 'etag', value: '' },
    { name: 'expect', value: '' },
    { name: 'expires', value: '' },
    { name: 'from', value: '' },
    { name: 'host', value: '' },
    { name: 'if-match', value: '' },
    { name: 'if-modified-since', value: '' },
    { name: 'if-none-match', value: '' },
    { name: 'if-range', value: '' },
    { name: 'if-unmodified-since', value: '' },
    { name: 'last-modified', value: '' },
    { name: 'link', value: '' },
    { name: 'location', value: '' },
    { name: 'max-forwards', value: '' },
    { name: 'proxy-authenticate', value: '' },
    { name: 'proxy-authorization', value: '' },
    { name: 'range', value: '' },
    { name: 'referer', value: '' },
    { name: 'refresh', value: '' },
    { name: 'retry-after', value: '' },
    { name: 'server', value: '' },
    { name: 'set-cookie', value: '' },
    { name: 'strict-transport-security', value: '' },
    { name: 'transfer-encoding', value: '' },
    { name: 'user-agent', value: '' },
    { name: 'vary', value: '' },
    { name: 'via', value: '' },
    { name: 'www-authenticate', value: '' },
];
/** Number of entries in the static table (61). */
exports.STATIC_TABLE_LENGTH = STATIC_TABLE.length - 1;
/**
 * Look up a static entry by its 1-based HPACK index.
 * Returns `undefined` when the index is outside the static table.
 */
function getStaticEntry(index) {
    if (index < 1 || index > exports.STATIC_TABLE_LENGTH) {
        return undefined;
    }
    return STATIC_TABLE[index];
}
/**
 * Find the best static-table reference for a header field.
 *
 * @returns `{index, exact: true}` for a full name+value match, otherwise
 *          `{index, exact: false}` for the first entry with the same
 *          name, otherwise `undefined`.
 */
function findStaticEntry(name, value) {
    let firstNameIndex = 0;
    for (let i = 1; i <= exports.STATIC_TABLE_LENGTH; i++) {
        const entry = STATIC_TABLE[i];
        if (entry.name === name) {
            if (firstNameIndex === 0) {
                firstNameIndex = i;
            }
            if (value !== undefined && entry.value === value) {
                return { index: i, exact: true };
            }
        }
    }
    return firstNameIndex === 0
        ? undefined
        : { index: firstNameIndex, exact: false };
}
