import type { TranscriptEntry, Settings } from './types';
import { DEFAULT_SETTINGS, KEEPALIVE_PORT_NAME } from './types';
import { STORAGE_DEBOUNCE_MS } from './constants';

const MERGE_WINDOW_MS = 60_000; // merge same-speaker entries within 1 minute

let entries: TranscriptEntry[] = [];
let settings: Settings = { ...DEFAULT_SETTINGS };
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let idCounter = 0;

// Progressive dedup: track messageId → { entryId, version }
const messageVersionMap = new Map<string, { entryId: string; version: number }>();

// Merge tracking: entryId → ordered text parts, messageId → part index in its entry
const entryParts = new Map<string, string[]>();
const messageIdToPartIndex = new Map<string, { entryId: string; index: number }>();
// Track last activity time per entry for merge window
const entryLastActivity = new Map<string, number>();

function generateId(): string {
  return `${Date.now()}-${++idCounter}`;
}

function rebuildEntryText(entryId: string): string {
  const parts = entryParts.get(entryId);
  if (!parts) return '';
  return parts.join(' ');
}

/**
 * Progressive dedup + same-speaker merging.
 *
 * Version update (existing messageId with higher version):
 *   → update that part's text, rebuild merged entry
 *
 * New messageId, same speaker within 1 min of last activity:
 *   → append as new part to existing entry
 *
 * New messageId, different speaker or >1 min gap:
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

      // Update the part in its entry
      const partInfo = messageIdToPartIndex.get(messageId);
      if (partInfo) {
        const parts = entryParts.get(partInfo.entryId);
        if (parts) {
          parts[partInfo.index] = text.trim();
        }
      }

      const entry = entries.find(e => e.id === existing.entryId);
      if (entry) {
        entry.text = rebuildEntryText(existing.entryId);
        entryLastActivity.set(existing.entryId, Date.now());
        schedulePersist();
        return { entry, isUpdate: true };
      }
    }

    // --- New messageId: try to merge with last entry ---
    const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
    const lastActivity = lastEntry ? (entryLastActivity.get(lastEntry.id) ?? lastEntry.timestamp) : 0;

    if (
      lastEntry &&
      lastEntry.speaker === speaker &&
      (Date.now() - lastActivity) < MERGE_WINDOW_MS
    ) {
      // Merge into last entry
      let parts = entryParts.get(lastEntry.id);
      if (!parts) {
        // First merge for this entry — seed with its current text
        parts = [lastEntry.text];
        entryParts.set(lastEntry.id, parts);
      }
      const index = parts.length;
      parts.push(text.trim());

      messageVersionMap.set(messageId, { entryId: lastEntry.id, version: messageVersion ?? 0 });
      messageIdToPartIndex.set(messageId, { entryId: lastEntry.id, index });
      entryLastActivity.set(lastEntry.id, Date.now());

      lastEntry.text = rebuildEntryText(lastEntry.id);
      schedulePersist();
      return { entry: lastEntry, isUpdate: true };
    }

    // --- New entry ---
    const entry: TranscriptEntry = {
      id: generateId(),
      text: text.trim(),
      speaker,
      timestamp: Date.now(),
      messageId,
    };
    entries.push(entry);
    entryParts.set(entry.id, [text.trim()]);
    messageVersionMap.set(messageId, { entryId: entry.id, version: messageVersion ?? 0 });
    messageIdToPartIndex.set(messageId, { entryId: entry.id, index: 0 });
    entryLastActivity.set(entry.id, Date.now());
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

export function clearEntries(): void {
  entries = [];
  idCounter = 0;
  messageVersionMap.clear();
  entryParts.clear();
  messageIdToPartIndex.clear();
  entryLastActivity.clear();
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
