import type { TranscriptEntry, Settings } from './types';
import { DEFAULT_SETTINGS } from './types';

let settings: Settings = { ...DEFAULT_SETTINGS };

const MERGE_WINDOW_MS = 30_000;

// --- Per-session state ---

interface SessionState {
  entries: TranscriptEntry[];
  messageVersionMap: Map<string, { entryId: string; version: number }>;
  entryPartsMap: Map<string, Array<{ messageId: string; text: string }>>;
  entryLastActivityMap: Map<string, number>;
  idCounter: number;
}

const sessionStates = new Map<string, SessionState>();

function getSession(sessionId: string): SessionState {
  let s = sessionStates.get(sessionId);
  if (!s) {
    s = {
      entries: [],
      messageVersionMap: new Map(),
      entryPartsMap: new Map(),
      entryLastActivityMap: new Map(),
      idCounter: 0,
    };
    sessionStates.set(sessionId, s);
  }
  return s;
}

function generateId(session: SessionState): string {
  return `${Date.now()}-${++session.idCounter}`;
}

function rebuildEntryText(session: SessionState, entryId: string): string {
  const parts = session.entryPartsMap.get(entryId);
  if (!parts || parts.length === 0) return '';
  return parts.map(p => p.text).join(' ');
}

/**
 * Progressive dedup + same-speaker merging within 30s window.
 *
 * Version update (existing messageId with higher version):
 *   → update that part's text, rebuild merged entry
 *
 * New messageId, same speaker within 30s of last entry:
 *   → append as new part to existing entry (merge)
 *
 * New messageId, different speaker or >30s gap:
 *   → create new entry
 */
export function updateOrAddEntry(
  sessionId: string,
  text: string,
  speaker: string,
  messageId?: string,
  messageVersion?: number,
  deviceId?: string,
): { entry: TranscriptEntry; isUpdate: boolean } | null {
  if (!text.trim()) return null;

  const session = getSession(sessionId);

  if (messageId) {
    // --- Version update for known messageId ---
    const existing = session.messageVersionMap.get(messageId);
    if (existing) {
      const version = messageVersion ?? 0;
      if (version <= existing.version) return null;

      existing.version = version;

      const entry = session.entries.find(e => e.id === existing.entryId);
      if (entry) {
        // Update this part's text and rebuild merged text
        const parts = session.entryPartsMap.get(entry.id);
        if (parts) {
          const part = parts.find(p => p.messageId === messageId);
          if (part) part.text = text.trim();
          entry.text = rebuildEntryText(session, entry.id);
        } else {
          entry.text = text.trim();
        }
        return { entry, isUpdate: true };
      }
    }

    // --- Try to merge into last entry if same speaker within 30s ---
    const last = session.entries.length > 0 ? session.entries[session.entries.length - 1] : null;
    const lastActivity = last ? (session.entryLastActivityMap.get(last.id) ?? last.timestamp) : 0;
    if (last && last.speaker === speaker && (Date.now() - lastActivity) < MERGE_WINDOW_MS) {
      const parts = session.entryPartsMap.get(last.id) ?? [];
      parts.push({ messageId, text: text.trim() });
      session.entryPartsMap.set(last.id, parts);
      session.messageVersionMap.set(messageId, { entryId: last.id, version: messageVersion ?? 0 });
      session.entryLastActivityMap.set(last.id, Date.now());
      last.text = rebuildEntryText(session, last.id);
      return { entry: last, isUpdate: true };
    }

    // --- New entry ---
    const now = Date.now();
    const entry: TranscriptEntry = {
      id: generateId(session),
      text: text.trim(),
      speaker,
      timestamp: now,
      messageId,
      deviceId,
    };
    session.entries.push(entry);
    session.entryPartsMap.set(entry.id, [{ messageId, text: text.trim() }]);
    session.entryLastActivityMap.set(entry.id, now);
    session.messageVersionMap.set(messageId, { entryId: entry.id, version: messageVersion ?? 0 });
    return { entry, isUpdate: false };
  }

  // No messageId — simple dedup by text within window
  if (isDuplicate(sessionId, text, speaker)) return null;

  const entry: TranscriptEntry = {
    id: generateId(session),
    text: text.trim(),
    speaker,
    timestamp: Date.now(),
    deviceId,
  };
  session.entries.push(entry);
  return { entry, isUpdate: false };
}

export function isDuplicate(sessionId: string, text: string, speaker: string, windowMs?: number): boolean {
  const window = windowMs ?? settings.dedupeWindowMs;
  const cutoff = Date.now() - window;
  const normalized = text.trim().toLowerCase();
  const session = getSession(sessionId);
  return session.entries.some(
    e => e.timestamp >= cutoff && e.text.trim().toLowerCase() === normalized && e.speaker === speaker,
  );
}

/** Retroactively rename entries by deviceId (catches entries with placeholder speaker). */
export function renameSpeakerByDeviceId(sessionId: string, deviceId: string, newName: string): TranscriptEntry[] {
  const session = getSession(sessionId);
  const updated: TranscriptEntry[] = [];
  for (const entry of session.entries) {
    if (entry.deviceId === deviceId && entry.speaker !== newName) {
      entry.speaker = newName;
      updated.push(entry);
    }
  }
  return updated;
}

export function getEntries(sessionId: string): TranscriptEntry[] {
  const session = getSession(sessionId);
  return [...session.entries];
}

export function clearEntries(sessionId: string): void {
  sessionStates.delete(sessionId);
}

/** Seed a session's transcript state from existing meeting entries (e.g. after SW restart). */
export function seedSession(sessionId: string, entries: TranscriptEntry[]): void {
  const session = getSession(sessionId);
  if (session.entries.length > 0) return; // already populated
  session.entries = [...entries];
  session.idCounter = entries.length;
  for (const entry of entries) {
    if (entry.messageId) {
      session.messageVersionMap.set(entry.messageId, { entryId: entry.id, version: 0 });
    }
  }
}

export function getSettings(): Settings {
  return { ...settings };
}

export function updateSettings(partial: Partial<Settings>): Settings {
  settings = { ...settings, ...partial };
  chrome.storage.local.set({ settings });
  return { ...settings };
}

export async function restoreFromStorage(): Promise<void> {
  try {
    const localData = await chrome.storage.local.get('settings');
    if (localData.settings) {
      settings = { ...DEFAULT_SETTINGS, ...localData.settings };
    }
  } catch { /* use defaults */ }
}

// --- Export formatters ---

export function exportAsText(data: TranscriptEntry[]): string {
  return data
    .map(e => {
      const time = new Date(e.timestamp).toLocaleTimeString();
      return `[${time}] ${e.speaker}: ${e.text}`;
    })
    .join('\n');
}

export function exportAsSrt(data: TranscriptEntry[]): string {
  return data
    .map((e, i) => {
      const start = formatSrtTime(e.timestamp - (data[0]?.timestamp ?? 0));
      const nextTs = data[i + 1]?.timestamp ?? e.timestamp + 3000;
      const end = formatSrtTime(nextTs - (data[0]?.timestamp ?? 0));
      return `${i + 1}\n${start} --> ${end}\n${e.speaker}: ${e.text}\n`;
    })
    .join('\n');
}

function formatSrtTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  const millis = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${millis}`;
}

export function exportAsVtt(data: TranscriptEntry[]): string {
  const lines = data.map((e, i) => {
    const start = formatVttTime(e.timestamp - (data[0]?.timestamp ?? 0));
    const nextTs = data[i + 1]?.timestamp ?? e.timestamp + 3000;
    const end = formatVttTime(nextTs - (data[0]?.timestamp ?? 0));
    return `${start} --> ${end}\n${e.speaker}: ${e.text}`;
  });
  return `WEBVTT\n\n${lines.join('\n\n')}`;
}

function formatVttTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  const millis = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s}.${millis}`;
}

export function exportAsJson(data: TranscriptEntry[]): string {
  const cleaned = data.map(({ deviceId: _deviceId, ...rest }) => rest);
  return JSON.stringify(cleaned, null, 2);
}

export function exportAsMarkdown(data: TranscriptEntry[], title?: string): string {
  const heading = title ?? 'Meeting Transcript';
  const dateStr = data.length > 0
    ? new Date(data[0].timestamp).toLocaleDateString()
    : new Date().toLocaleDateString();

  const lines = [`# ${heading}`, `**Date:** ${dateStr}`, ''];

  for (const e of data) {
    const time = new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    lines.push(`**${e.speaker}** _(${time})_`);
    lines.push('');
    lines.push(e.text);
    lines.push('');
  }

  return lines.join('\n');
}
