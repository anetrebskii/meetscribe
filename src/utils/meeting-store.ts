import type { Meeting, TranscriptEntry } from './types';
import { STORAGE_DEBOUNCE_MS, MEETING_RESUME_WINDOW_MS } from './constants';

const STORAGE_KEY = 'meetings';

let meetings: Map<string, Meeting> = new Map();
let currentMeetingId: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let idCounter = 0;

function generateId(): string {
  return `meeting-${Date.now()}-${++idCounter}`;
}


/** Find the title from a past meeting with the same code (most recent first). */
export function findTitleByCode(meetingCode: string): string | null {
  let best: Meeting | null = null;
  for (const meeting of meetings.values()) {
    if (meeting.meetingCode === meetingCode && meeting.title !== meetingCode) {
      if (!best || meeting.startTime > best.startTime) best = meeting;
    }
  }
  return best?.title ?? null;
}

/** Return unique meeting titles for autocomplete. */
export function getMeetingTitles(): string[] {
  const titles = new Set<string>();
  for (const meeting of meetings.values()) {
    if (meeting.title && meeting.title !== meeting.meetingCode) {
      titles.add(meeting.title);
    }
  }
  return Array.from(titles);
}

export function createMeeting(meetingCode: string): Meeting {
  const now = Date.now();
  const existingTitle = findTitleByCode(meetingCode);
  const meeting: Meeting = {
    id: generateId(),
    meetingCode,
    title: existingTitle ?? meetingCode,
    description: '',
    startTime: now,
    endTime: null,
    participants: {},
    entries: [],
  };
  meetings.set(meeting.id, meeting);
  currentMeetingId = meeting.id;
  schedulePersist();
  return meeting;
}

export function getCurrentMeeting(): Meeting | null {
  if (!currentMeetingId) return null;
  return meetings.get(currentMeetingId) ?? null;
}

export function getCurrentMeetingId(): string | null {
  return currentMeetingId;
}

export function setCurrentMeetingId(id: string | null): void {
  currentMeetingId = id;
}

export function updateMeeting(id: string, partial: Partial<Meeting>): Meeting | null {
  const meeting = meetings.get(id);
  if (!meeting) return null;
  Object.assign(meeting, partial);
  schedulePersist();
  return meeting;
}

export function addParticipant(meetingId: string, deviceId: string, name: string): void {
  const meeting = meetings.get(meetingId);
  if (!meeting) return;
  meeting.participants[deviceId] = name;
  meeting.description = [...new Set(Object.values(meeting.participants))].join(', ');
  schedulePersist();
}

export function addTranscriptEntry(meetingId: string, entry: TranscriptEntry): void {
  const meeting = meetings.get(meetingId);
  if (!meeting) return;
  meeting.entries.push({ ...entry });
  schedulePersist();
}

export function updateEntryText(meetingId: string, entryId: string, text: string): void {
  const meeting = meetings.get(meetingId);
  if (!meeting) return;
  const entry = meeting.entries.find(e => e.id === entryId);
  if (entry) {
    entry.text = text.trim();
    schedulePersist();
  }
}

export function updateEntrySpeaker(meetingId: string, entryId: string, speaker: string): void {
  const meeting = meetings.get(meetingId);
  if (!meeting) return;
  const entry = meeting.entries.find(e => e.id === entryId);
  if (entry) {
    entry.speaker = speaker;
    schedulePersist();
  }
}

export function endMeeting(id: string): void {
  const meeting = meetings.get(id);
  if (!meeting) return;
  meeting.endTime = Date.now();
  if (currentMeetingId === id) currentMeetingId = null;
  schedulePersist();
}

export function getMeetings(): Omit<Meeting, 'entries'>[] {
  return Array.from(meetings.values())
    .sort((a, b) => b.startTime - a.startTime)
    .map(({ entries: _entries, ...meta }) => meta);
}

export function getMeeting(id: string): Meeting | null {
  return meetings.get(id) ?? null;
}

export function renameMeeting(id: string, title: string): Meeting | null {
  const meeting = meetings.get(id);
  if (!meeting) return null;
  meeting.title = title;
  schedulePersist();
  return meeting;
}

export function findRecentMeeting(meetingCode: string): Meeting | null {
  const now = Date.now();
  for (const meeting of meetings.values()) {
    if (meeting.meetingCode !== meetingCode) continue;
    const gap = meeting.endTime !== null
      ? now - meeting.endTime
      : now - meeting.startTime;
    if (gap <= MEETING_RESUME_WINDOW_MS) {
      return meeting;
    }
  }
  return null;
}

export function resumeMeeting(id: string): Meeting | null {
  const meeting = meetings.get(id);
  if (!meeting) return null;
  meeting.endTime = null;
  currentMeetingId = id;
  schedulePersist();
  return meeting;
}

export function deleteMeeting(id: string): boolean {
  const deleted = meetings.delete(id);
  if (deleted) schedulePersist();
  return deleted;
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, STORAGE_DEBOUNCE_MS);
}

function persistNow(): void {
  const data = Object.fromEntries(meetings);
  chrome.storage.local.set({ [STORAGE_KEY]: data }).catch(() => {});
}

export async function restoreMeetings(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY];
    if (stored && typeof stored === 'object') {
      meetings = new Map(Object.entries(stored as Record<string, Meeting>));
    }
  } catch {
    // empty storage on first load
  }
}
