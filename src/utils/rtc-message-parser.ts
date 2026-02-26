import { decodeProtobuf, extractAllStrings, type ProtoField } from './protobuf-decoder';

const LOG_PREFIX = '[MeetTranscript]';

export interface RtcCaption {
  deviceId: string;
  messageId: string;
  messageVersion: number;
  langId: number;
  text: string;
}

export interface RtcDeviceInfo {
  deviceId: string;
  deviceName: string;
}

export interface RtcChat {
  deviceId: string;
  messageId: string;
  text: string;
}

// --- Field tree helpers ---

function findField(fields: ProtoField[], fieldNumber: number): ProtoField | undefined {
  return fields.find(f => f.fieldNumber === fieldNumber);
}

function getNestedFields(fields: ProtoField[], fieldNumber: number): ProtoField[] | null {
  const field = findField(fields, fieldNumber);
  if (field && Array.isArray(field.value)) return field.value;
  return null;
}

function getString(fields: ProtoField[], fieldNumber: number): string | null {
  const field = findField(fields, fieldNumber);
  if (field && typeof field.value === 'string') return field.value;
  return null;
}

function getNumber(fields: ProtoField[], fieldNumber: number): number | null {
  const field = findField(fields, fieldNumber);
  if (field && typeof field.value === 'number') return field.value;
  if (field && typeof field.value === 'bigint') return Number(field.value);
  return null;
}

/**
 * Parse a caption message from the "captions" DataChannel.
 *
 * Expected protobuf structure (observed from Google Meet):
 *   field 1 (nested) = wrapper
 *     field 1 (string) = deviceId
 *     field 2 (varint) = messageId
 *     field 3 (varint) = messageVersion
 *     field 5 (varint) = langId
 *     field 6 (string) = text        (sometimes field 4)
 *
 * The outer message sometimes has a field 2 that is a "keepalive" — skip those.
 */
let captionFieldsDumped = false;

export function parseCaptionMessage(data: Uint8Array): RtcCaption | null {
  try {
    const fields = decodeProtobuf(data);

    // If field 2 exists at top level without field 1 nested, it's a keepalive
    const wrapper = getNestedFields(fields, 1);
    if (!wrapper) return null;

    // Debug: dump all fields from first few caption messages
    if (!captionFieldsDumped) {
      captionFieldsDumped = true;
      const allStrings = extractAllStrings(wrapper);
      const fieldSummary = wrapper.map(f => `f${f.fieldNumber}(${typeof f.value === 'string' ? `str:"${f.value.substring(0, 50)}"` : Array.isArray(f.value) ? 'nested' : f.value})`);
      console.debug(LOG_PREFIX, 'RTC caption fields:', fieldSummary);
      console.debug(LOG_PREFIX, 'RTC caption all strings:', allStrings);
    }

    const deviceId = getString(wrapper, 1);
    const messageId = getNumber(wrapper, 2);
    const messageVersion = getNumber(wrapper, 3);
    const langId = getNumber(wrapper, 5) ?? getNumber(wrapper, 4);
    // Text can be in field 6 or field 4 depending on version
    const text = getString(wrapper, 6) ?? getString(wrapper, 4) ?? getString(wrapper, 7) ?? '';

    if (!deviceId || messageId === null || messageVersion === null) {
      console.debug(LOG_PREFIX, 'RTC caption parse: missing required fields', { deviceId, messageId, messageVersion });
      return null;
    }

    return {
      deviceId: `@${deviceId}`,
      messageId: `${messageId}/@${deviceId}`,
      messageVersion,
      langId: langId ?? 0,
      text,
    };
  } catch (e) {
    console.debug(LOG_PREFIX, 'RTC caption parse error:', e);
    return null;
  }
}

/**
 * Parse device info from the "collections" DataChannel.
 *
 * Expected structure (single device update):
 *   field 1 (nested)
 *     field 1 (nested)
 *       field 1 (nested)
 *         field 1 (nested)
 *           field 1 (nested)
 *             field 1 (string) = deviceId
 *             field 2 (string) = deviceName
 */
export function parseDeviceInfo(data: Uint8Array): RtcDeviceInfo | null {
  try {
    const fields = decodeProtobuf(data);
    // Walk down nested field 1s to find deviceId/deviceName pair
    const info = walkForDeviceInfo(fields, 0);
    return info;
  } catch (e) {
    console.debug(LOG_PREFIX, 'RTC device info parse error:', e);
    return null;
  }
}

function looksLikeDeviceId(s: string): boolean {
  return s.includes('/devices/') || s.includes('spaces/');
}

function walkForDeviceInfo(fields: ProtoField[], depth: number): RtcDeviceInfo | null {
  if (depth > 10) return null;

  const f1str = getString(fields, 1);
  const f2str = getString(fields, 2);

  // Match: field 1 = device path, field 2 = display name
  if (f1str && f2str && looksLikeDeviceId(f1str) && !looksLikeDeviceId(f2str)) {
    return { deviceId: `@${f1str}`, deviceName: f2str };
  }

  // Recurse into ALL nested fields
  for (const field of fields) {
    if (Array.isArray(field.value)) {
      const result = walkForDeviceInfo(field.value, depth + 1);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Parse a full device collection from the "collections" DataChannel.
 * Returns an array of all devices found in the message.
 */
export function parseDeviceCollection(data: Uint8Array): RtcDeviceInfo[] {
  try {
    const fields = decodeProtobuf(data);
    const devices: RtcDeviceInfo[] = [];
    collectDevices(fields, devices, 0);

    // Fallback: if structured parse found nothing, try string pair extraction
    if (devices.length === 0) {
      const allStrings = extractAllStrings(fields);
      // Look for adjacent string pairs where first looks like device path
      for (let i = 0; i < allStrings.length - 1; i++) {
        const a = allStrings[i].value;
        const b = allStrings[i + 1].value;
        if (looksLikeDeviceId(a) && !looksLikeDeviceId(b) && b.length >= 2 && b.length <= 80 && !/^[0-9]+$/.test(b)) {
          devices.push({ deviceId: `@${a}`, deviceName: b });
          console.debug(LOG_PREFIX, 'RTC: fallback device match:', a, '→', b);
          i++; // skip the name we just consumed
        }
      }
    }

    return devices;
  } catch (e) {
    console.debug(LOG_PREFIX, 'RTC device collection parse error:', e);
    return [];
  }
}

function collectDevices(fields: ProtoField[], result: RtcDeviceInfo[], depth: number): void {
  if (depth > 12) return;

  const f1str = getString(fields, 1);
  const f2str = getString(fields, 2);

  // Match: field 1 = device path, field 2 = display name
  if (f1str && f2str && looksLikeDeviceId(f1str) && !looksLikeDeviceId(f2str)) {
    result.push({ deviceId: `@${f1str}`, deviceName: f2str });
    return; // Don't recurse further into this device node
  }

  for (const field of fields) {
    if (Array.isArray(field.value)) {
      collectDevices(field.value, result, depth + 1);
    }
  }
}

/**
 * Parse a chat message from the "meet_messages" DataChannel.
 *
 * Expected structure:
 *   field 1 (nested)
 *     field 1 (nested)
 *       field 1 (nested)
 *         field 1 (nested)
 *           field 1 (nested)
 *             field 1 (string) = deviceId (contains "/messages/" path)
 *           field 2 (string) = deviceId
 *         field 3 (varint) = timestamp
 *       field 1 (nested)
 *         field 1 (string) = text
 */
export function parseChatMessage(data: Uint8Array): RtcChat | null {
  try {
    const fields = decodeProtobuf(data);
    return walkForChat(fields, 0);
  } catch (e) {
    console.debug(LOG_PREFIX, 'RTC chat parse error:', e);
    return null;
  }
}

function walkForChat(fields: ProtoField[], depth: number): RtcChat | null {
  if (depth > 10) return null;

  // Look for a string that contains "/messages/" — that's the chat message path
  for (const field of fields) {
    if (typeof field.value === 'string' && field.value.includes('/messages/')) {
      // Found the message path — extract sibling fields for deviceId and text
      const deviceId = findChatDeviceId(fields);
      const text = findChatText(fields, depth);
      if (deviceId && text) {
        const messageIdMatch = field.value.match(/\/messages\/([^/]+)/);
        const messageId = messageIdMatch ? `${messageIdMatch[1]}/${deviceId}` : `${Date.now()}/${deviceId}`;
        return { deviceId: `@${deviceId}`, messageId, text };
      }
    }
  }

  // Recurse into nested fields
  for (const field of fields) {
    if (Array.isArray(field.value)) {
      const result = walkForChat(field.value, depth + 1);
      if (result) return result;
    }
  }

  return null;
}

function findChatDeviceId(fields: ProtoField[]): string | null {
  // Look for a string in field 2 that looks like a device ID
  const f2 = getString(fields, 2);
  if (f2 && !f2.includes('/')) return f2;

  // Search nested
  for (const field of fields) {
    if (Array.isArray(field.value)) {
      const id = findChatDeviceId(field.value);
      if (id) return id;
    }
  }
  return null;
}

function findChatText(fields: ProtoField[], depth: number): string | null {
  if (depth > 10) return null;

  // Look for text in nested structures — typically in a "value" sub-message
  for (const field of fields) {
    if (typeof field.value === 'string' && !field.value.includes('/') && field.value.length >= 1) {
      return field.value;
    }
    if (Array.isArray(field.value)) {
      const text = findChatText(field.value, depth + 1);
      if (text) return text;
    }
  }
  return null;
}

/** Debug helper: dump all strings from a protobuf message */
export function dumpAllStrings(data: Uint8Array): string[] {
  try {
    const fields = decodeProtobuf(data);
    return extractAllStrings(fields).map(s => `f${s.fieldNumber}: ${s.value}`);
  } catch {
    return [];
  }
}
