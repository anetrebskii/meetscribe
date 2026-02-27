import type { TranscriptEntry, Settings } from './types';
import { DEFAULT_SETTINGS, KEEPALIVE_PORT_NAME } from './types';
import { STORAGE_DEBOUNCE_MS } from './constants';

let entries: TranscriptEntry[] = [];
let settings: Settings = { ...DEFAULT_SETTINGS };
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let idCounter = 0;

const MERGE_WINDOW_MS = 30_000;

// Progressive dedup: track messageId → { entryId, version }
const messageVersionMap = new Map<string, { entryId: string; version: number }>();

// Track parts per merged entry: entryId → [{ messageId, text }]
const entryPartsMap = new Map<string, Array<{ messageId: string; text: string }>>();

// Track last activity time per entry for merge window
const entryLastActivityMap = new Map<string, number>();

function generateId(): string {
  return `${Date.now()}-${++idCounter}`;
}

function rebuildEntryText(entryId: string): string {
  const parts = entryPartsMap.get(entryId);
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
  text: string,
  speaker: string,
  messageId?: string,
  messageVersion?: number,
): { entry: TranscriptEntry; isUpdate: boolean } | null {
  if (!text.trim()) return null;

  if (messageId) {
    // --- Version update for known messageId ---
    const existing = messageVersionMap.get(messageId);
    if (existing) {
      const version = messageVersion ?? 0;
      if (version <= existing.version) return null;

      existing.version = version;

      const entry = entries.find(e => e.id === existing.entryId);
      if (entry) {
        // Update this part's text and rebuild merged text
        const parts = entryPartsMap.get(entry.id);
        if (parts) {
          const part = parts.find(p => p.messageId === messageId);
          if (part) part.text = text.trim();
          entry.text = rebuildEntryText(entry.id);
        } else {
          entry.text = text.trim();
        }
        schedulePersist();
        return { entry, isUpdate: true };
      }
    }

    // --- Try to merge into last entry if same speaker within 30s ---
    const last = entries.length > 0 ? entries[entries.length - 1] : null;
    const lastActivity = last ? (entryLastActivityMap.get(last.id) ?? last.timestamp) : 0;
    if (last && last.speaker === speaker && (Date.now() - lastActivity) < MERGE_WINDOW_MS) {
      const parts = entryPartsMap.get(last.id) ?? [];
      parts.push({ messageId, text: text.trim() });
      entryPartsMap.set(last.id, parts);
      messageVersionMap.set(messageId, { entryId: last.id, version: messageVersion ?? 0 });
      entryLastActivityMap.set(last.id, Date.now());
      last.text = rebuildEntryText(last.id);
      schedulePersist();
      return { entry: last, isUpdate: true };
    }

    // --- New entry ---
    const now = Date.now();
    const entry: TranscriptEntry = {
      id: generateId(),
      text: text.trim(),
      speaker,
      timestamp: now,
      messageId,
    };
    entries.push(entry);
    entryPartsMap.set(entry.id, [{ messageId, text: text.trim() }]);
    entryLastActivityMap.set(entry.id, now);
    messageVersionMap.set(messageId, { entryId: entry.id, version: messageVersion ?? 0 });
    schedulePersist();
    return { entry, isUpdate: false };
  }

  // No messageId — simple dedup by text within window
  if (isDuplicate(text, speaker)) return null;

  const entry: TranscriptEntry = {
    id: generateId(),
    text: text.trim(),
    speaker,
    timestamp: Date.now(),
  };
  entries.push(entry);
  schedulePersist();
  return { entry, isUpdate: false };
}

export function isDuplicate(text: string, speaker: string, windowMs?: number): boolean {
  const window = windowMs ?? settings.dedupeWindowMs;
  const cutoff = Date.now() - window;
  const normalized = text.trim().toLowerCase();
  return entries.some(
    e => e.timestamp >= cutoff && e.text.trim().toLowerCase() === normalized && e.speaker === speaker,
  );
}

/** Retroactively rename all entries with oldName to newName. Returns updated entries. */
export function renameSpeaker(oldName: string, newName: string): TranscriptEntry[] {
  const updated: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.speaker === oldName) {
      entry.speaker = newName;
      updated.push(entry);
    }
  }
  if (updated.length > 0) schedulePersist();
  return updated;
}

export function getEntries(): TranscriptEntry[] {
  return [...entries];
}

export function restoreEntries(stored: TranscriptEntry[]): void {
  entries = [...stored];
  idCounter = entries.length;
  messageVersionMap.clear();
  entryPartsMap.clear();
  entryLastActivityMap.clear();
  for (const entry of entries) {
    if (entry.messageId) {
      messageVersionMap.set(entry.messageId, { entryId: entry.id, version: 0 });
    }
  }
}

export function clearEntries(): void {
  entries = [];
  idCounter = 0;
  messageVersionMap.clear();
  entryPartsMap.clear();
  entryLastActivityMap.clear();
  persistNow();
}

export function getSettings(): Settings {
  return { ...settings };
}

export function updateSettings(partial: Partial<Settings>): Settings {
  settings = { ...settings, ...partial };
  chrome.storage.local.set({ settings });
  return { ...settings };
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, STORAGE_DEBOUNCE_MS);
}

function persistNow(): void {
  chrome.storage.session.set({ transcript: entries }).catch(() => {});
}

export async function restoreFromStorage(): Promise<void> {
  try {
    const sessionData = await chrome.storage.session.get('transcript');
    if (sessionData.transcript && Array.isArray(sessionData.transcript)) {
      entries = sessionData.transcript;
      idCounter = entries.length;
      // Rebuild messageVersionMap from restored entries
      for (const entry of entries) {
        if (entry.messageId) {
          messageVersionMap.set(entry.messageId, { entryId: entry.id, version: 0 });
        }
      }
    }
  } catch { /* empty session storage on first load */ }

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
  return JSON.stringify(data, null, 2);
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
