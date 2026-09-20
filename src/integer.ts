import { HpackDecodingError } from "./errors.js";

/**
 * Integer representation (RFC 7541, Section 5.1).
 *
 * Integers share the first byte with other fields: the low `prefixBits` bits
 * hold the start of the integer and the remaining high bits (`highBits`) hold
 * that byte's context (representation kind / index).
 */

export function encodeInteger(
  value: number,
  prefixBits: number,
  highBits: number = 0,
): Buffer {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`value must be a non-negative safe integer, got ${value}`);
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`integer is too large to encode safely: ${value}`);
  }
  if (!Number.isInteger(prefixBits) || prefixBits < 1 || prefixBits > 8) {
    throw new RangeError(`prefixBits must be in 1..8, got ${prefixBits}`);
  }

  // The integer occupies the low `prefixBits` bits of the first byte; the
  // remaining high bits hold context (representation kind / index).
  const maxFirst = (1 << prefixBits) - 1;
  const highMask = 0xff ^ maxFirst;
  const firstByte = highBits & highMask;

  if (value < maxFirst) {
    return Buffer.from([(firstByte | value) & 0xff]);
  }

  // Continuation encoding. 5 bytes of 7 bits plus a final byte of <= 4 bits
  // covers the full 32-bit range the wire format is expected to carry.
  const out: number[] = [firstByte | maxFirst];
  let rest = value - maxFirst;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
    if (out.length > 6) {
      throw new RangeError(`integer is too large to encode: ${value}`);
    }
  }
  out.push(rest);
  return Buffer.from(out);
}

/**
 * Cursor over a header block. Every failed read throws {@link HpackDecodingError}.
 */
export class Reader {
  offset: number;

  constructor(
    readonly buffer: Buffer,
    start: number = 0,
  ) {
    if (start < 0 || start > buffer.length) {
      throw new HpackDecodingError("reader start is out of bounds");
    }
    this.offset = start;
  }

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  readByte(): number {
    if (this.remaining < 1) {
      throw new HpackDecodingError("unexpected end of header block");
    }
    return this.buffer[this.offset++]!;
  }

  peekByte(): number {
    if (this.remaining < 1) {
      throw new HpackDecodingError("unexpected end of header block");
    }
    return this.buffer[this.offset]!;
  }

  /** Read an integer (Section 5.1) whose first byte is already consumed. */
  readIntegerAfterPrefix(prefixMax: number, prefixValue: number): number {
    let value = prefixValue;
    if (prefixValue < prefixMax) {
      return value;
    }
    let shift = 0;
    for (;;) {
      const b = this.readByte();
      value += (b & 0x7f) * 2 ** shift;
      if (value > 0xffffffff || !Number.isSafeInteger(value)) {
        throw new HpackDecodingError("encoded integer is too large");
      }
      if ((b & 0x80) === 0) {
        return value;
      }
      shift += 7;
      if (shift > 28) {
        throw new HpackDecodingError("encoded integer is too large");
      }
    }
  }

  /**
   * Read an integer encoded in the low bits of the next byte.
   * Returns the full first byte so the caller can inspect the high bits.
   */
  readPrefixedInteger(prefixBits: number): { firstByte: number; value: number } {
    const prefixMax = (1 << prefixBits) - 1;
    const firstByte = this.readByte();
    const prefixValue = firstByte & prefixMax;
    return { firstByte, value: this.readIntegerAfterPrefix(prefixMax, prefixValue) };
  }

  readBytes(length: number): Buffer {
    if (length < 0) {
      throw new HpackDecodingError("negative length in header block");
    }
    if (this.remaining < length) {
      throw new HpackDecodingError("truncated string in header block");
    }
    const slice = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }
}
