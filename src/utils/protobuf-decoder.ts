export interface ProtoField {
  fieldNumber: number;
  wireType: number;
  value: string | number | bigint | Uint8Array | ProtoField[];
}

class BufferReader {
  private view: DataView;
  pos = 0;

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error('varint too long');
    }
    throw new Error('unexpected end of varint');
  }

  readFixed32(): number {
    if (this.remaining < 4) throw new Error('not enough bytes for fixed32');
    const val = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return val;
  }

  readFixed64(): bigint {
    if (this.remaining < 8) throw new Error('not enough bytes for fixed64');
    const lo = BigInt(this.view.getUint32(this.pos, true));
    const hi = BigInt(this.view.getUint32(this.pos + 4, true));
    this.pos += 8;
    return (hi << 32n) | lo;
  }

  readBytes(len: number): Uint8Array {
    if (this.remaining < len) throw new Error('not enough bytes');
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });

function isPrintableUtf8(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  try {
    const str = textDecoder.decode(bytes);
    let printable = 0;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (
        (code >= 0x20 && code <= 0x7e) || // ASCII printable
        code === 0x0a || code === 0x0d ||  // newlines
        code === 0x09 ||                   // tab
        code > 0x7f                        // multibyte (non-ASCII unicode)
      ) {
        printable++;
      }
    }
    const ratio = printable / str.length;
    return ratio > 0.8 ? str : null;
  } catch {
    return null;
  }
}

export function decodeProtobuf(data: Uint8Array): ProtoField[] {
  const reader = new BufferReader(data);
  const fields: ProtoField[] = [];

  while (reader.remaining > 0) {
    let tag: bigint;
    try {
      tag = reader.readVarint();
    } catch {
      break;
    }

    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n);

    if (fieldNumber === 0) break;

    try {
      switch (wireType) {
        case 0: { // varint
          const val = reader.readVarint();
          fields.push({ fieldNumber, wireType, value: val <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(val) : val });
          break;
        }
        case 1: { // fixed64
          fields.push({ fieldNumber, wireType, value: reader.readFixed64() });
          break;
        }
        case 2: { // length-delimited
          const len = Number(reader.readVarint());
          if (len < 0 || len > reader.remaining) break;
          const bytes = reader.readBytes(len);
          // Try as UTF-8 string first
          const str = isPrintableUtf8(bytes);
          if (str !== null) {
            fields.push({ fieldNumber, wireType, value: str });
          } else {
            // Try as nested protobuf
            try {
              const nested = decodeProtobuf(bytes);
              if (nested.length > 0) {
                fields.push({ fieldNumber, wireType, value: nested });
              } else {
                fields.push({ fieldNumber, wireType, value: bytes });
              }
            } catch {
              fields.push({ fieldNumber, wireType, value: bytes });
            }
          }
          break;
        }
        case 5: { // fixed32
          fields.push({ fieldNumber, wireType, value: reader.readFixed32() });
          break;
        }
        default:
          // Unknown wire type — stop parsing
          return fields;
      }
    } catch {
      break;
    }
  }

  return fields;
}

export function extractAllStrings(fields: ProtoField[]): Array<{ fieldNumber: number; value: string }> {
  const results: Array<{ fieldNumber: number; value: string }> = [];

  for (const field of fields) {
    if (typeof field.value === 'string') {
      results.push({ fieldNumber: field.fieldNumber, value: field.value });
    } else if (Array.isArray(field.value)) {
      results.push(...extractAllStrings(field.value));
    }
  }

  return results;
}
