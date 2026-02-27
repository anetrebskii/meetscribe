/** Minimal protobuf encoder — just enough to build UpdateMediaSession requests. */

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return new Uint8Array(bytes);
}

function encodeTag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeString(fieldNumber: number, value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const tag = encodeTag(fieldNumber, 2); // wire type 2 = length-delimited
  const len = encodeVarint(encoded.length);
  const result = new Uint8Array(tag.length + len.length + encoded.length);
  result.set(tag, 0);
  result.set(len, tag.length);
  result.set(encoded, tag.length + len.length);
  return result;
}

function encodeMessage(fieldNumber: number, inner: Uint8Array): Uint8Array {
  const tag = encodeTag(fieldNumber, 2); // wire type 2 = length-delimited
  const len = encodeVarint(inner.length);
  const result = new Uint8Array(tag.length + len.length + inner.length);
  result.set(tag, 0);
  result.set(len, tag.length);
  result.set(inner, tag.length + len.length);
  return result;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Encode the UpdateMediaSession request body as protobuf.
 *
 * Mirrors Tactiq's structure:
 *   UpdateMediaSessionBody {
 *     1: mediaSessionConfig {
 *       1: sessionId  = "mediasessions/<id>"
 *       5: captionPreferences {
 *         1: pair (repeated) {
 *           1: lang1 = langCode
 *           2: lang2 = langCode
 *         }
 *       }
 *     }
 *     2: clientConfig {
 *       1: captionConfig = "client_config.caption_config"
 *     }
 *   }
 */
export function encodeUpdateMediaSession(sessionId: string, langCode: string): Uint8Array {
  // LanguagePair { 1: lang1, 2: lang2 }
  const pair = concat(
    encodeString(1, langCode),
    encodeString(2, langCode),
  );

  // CaptionPreferences { 1: pair }
  const captionPreferences = encodeMessage(1, pair);

  // MediaSessionConfig { 1: sessionId, 5: captionPreferences }
  const mediaSessionConfig = concat(
    encodeString(1, `mediasessions/${sessionId}`),
    encodeMessage(5, captionPreferences),
  );

  // ClientConfig { 1: captionConfig }
  const clientConfig = encodeString(1, 'client_config.caption_config');

  // UpdateMediaSessionBody { 1: mediaSessionConfig, 2: clientConfig }
  return concat(
    encodeMessage(1, mediaSessionConfig),
    encodeMessage(2, clientConfig),
  );
}
