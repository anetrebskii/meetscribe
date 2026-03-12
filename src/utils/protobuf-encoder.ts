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
 * Field numbers extracted from Tactiq's protobufjs schema:
 *   UpdateMediaSessionBody {
 *     1: mediaSessionConfig {
 *       1: sessionId  = "mediasessions/<id>"
 *       3: captionPreferences {
 *         9: pair (repeated) {
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
/**
 * Encode language change for RTC media-session data channel.
 *
 * Observed wire format (decoded from Google Meet's own sends):
 *   field 1 (message):
 *     field 2 (message):
 *       field 1 (varint): 3
 *       field 3 (message):
 *         field 1 (message):
 *           field 9 (pair): { 1: lang, 2: lang }
 *         field 2 (message):
 *           field 1: "client_config.caption_config"
 */
export function encodeRtcLanguageChange(langCode: string): Uint8Array {
  const pair = concat(
    encodeString(1, langCode),
    encodeString(2, langCode),
  );
  const captionPreferences = encodeMessage(9, pair);
  const clientConfig = encodeString(1, 'client_config.caption_config');

  // inner field 3: { field 1: captionPreferences, field 2: clientConfig }
  const field3 = concat(
    encodeMessage(1, captionPreferences),
    encodeMessage(2, clientConfig),
  );

  // field 2: { field 1: varint 3, field 3: ... }
  const varint3 = concat(encodeTag(1, 0), encodeVarint(3));
  const field2 = concat(varint3, encodeMessage(3, field3));

  // outer: { field 1: { field 2: ... } }
  return encodeMessage(1, encodeMessage(2, field2));
}

export function encodeUpdateMediaSession(sessionId: string, langCode: string): Uint8Array {
  // LanguagePair { 1: lang1, 2: lang2 }
  const pair = concat(
    encodeString(1, langCode),
    encodeString(2, langCode),
  );

  // CaptionPreferences { 9: pair }
  const captionPreferences = encodeMessage(9, pair);

  // MediaSessionConfig { 1: sessionId, 3: captionPreferences }
  const mediaSessionConfig = concat(
    encodeString(1, `mediasessions/${sessionId}`),
    encodeMessage(3, captionPreferences),
  );

  // ClientConfig { 1: captionConfig }
  const clientConfig = encodeString(1, 'client_config.caption_config');

  // UpdateMediaSessionBody { 1: mediaSessionConfig, 2: clientConfig }
  return concat(
    encodeMessage(1, mediaSessionConfig),
    encodeMessage(2, clientConfig),
  );
}
