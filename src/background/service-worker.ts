import {
  MSG,
  KEEPALIVE_PORT_NAME,
  POPUP_PORT_NAME,
  type TranscriptEntry,
  type ExtensionMessage,
} from '../utils/types';
import {
  updateOrAddEntry,
  getEntries,
  clearEntries,
  seedSession,
  getSettings,
  updateSettings,
  restoreFromStorage,
  renameSpeakerByDeviceId,
  exportAsText,
  exportAsSrt,
  exportAsVtt,
  exportAsJson,
  exportAsMarkdown,
} from '../utils/transcript-store';
import { MEETING_CODE_DEDUP_MS } from '../utils/constants';
import {
  createMeeting,
  addParticipant,
  addTranscriptEntry,
  updateEntryText,
  updateEntrySpeaker,
  updateMeeting,
  findTitleByCode,
  endMeeting,
  getMeetings,
  getMeeting,
  renameMeeting,
  deleteMeeting,
  restoreMeetings,
  getMeetingTitles,
  findRecentMeeting,
  resumeMeeting,
  addNote,
  updateNote,
  deleteNote,
} from '../utils/meeting-store';
import * as notula from './notula-sync';

// --- Per-session state ---

interface Session {
  meetingId: string | null;
  meetingCode: string | null;
  recentActiveDevices: Array<{ deviceId: string; timestamp: number }>;
}

const sessions = new Map<string, Session>();
const tabSessionMap = new Map<number, string>(); // tabId → sessionId
/**
 * The alarm that ends a session's meeting once its tab has been gone for the
 * grace period. An alarm outlives a service worker Chrome has put to sleep; a
 * timer dies with it, which is how a closed tab used to leave a meeting live
 * for good.
 */
const END_ALARM = 'end-session:';

function getOrCreateSession(sessionId: string): Session {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { meetingId: null, meetingCode: null, recentActiveDevices: [] };
    sessions.set(sessionId, s);
  }
  return s;
}

/** Resolve sessionId from a message (preferred) or from sender's tab ID. */
function resolveSessionId(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): string | null {
  if (typeof message.sessionId === 'string') return message.sessionId;
  const tabId = sender.tab?.id;
  if (tabId != null) return tabSessionMap.get(tabId) ?? null;
  return null;
}

/** Get all meetingIds that are currently live (have an active session). */
function getLiveMeetingIds(): string[] {
  const ids = new Set<string>();
  for (const s of sessions.values()) {
    if (s.meetingId) ids.add(s.meetingId);
  }
  return [...ids];
}

// --- Global state ---

const popupPorts = new Map<chrome.runtime.Port, string | undefined>(); // port → sessionId
const DEVICE_MAP_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const deviceMap = new Map<string, { name: string; ts: number }>(); // deviceId → { name, timestamp }
const KEEPALIVE_GRACE_MS = 120_000; // 2 minutes grace before ending meeting
// Debounce device refresh requests
let deviceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const DEVICE_REFRESH_DEBOUNCE_MS = 3_000;
// Track last caption data time per session to detect stalled transcription
const lastCaptionTime = new Map<string, number>();
const CAPTION_STALL_MS = 30_000; // 30s without captions triggers retry
const captionStallTimers = new Map<string, ReturnType<typeof setTimeout>>();

// --- Session state persistence (survives service worker restarts & extension updates) ---

let sessionPersistTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSessionPersist(): void {
  if (sessionPersistTimer) return;
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null;
    // deviceMap goes to chrome.storage.local so it survives extension updates.
    // Prune expired entries before persisting.
    const now = Date.now();
    const persistMap: Record<string, { name: string; ts: number }> = {};
    for (const [k, v] of deviceMap) {
      if (now - v.ts < DEVICE_MAP_TTL_MS) {
        persistMap[k] = v;
      } else {
        deviceMap.delete(k);
      }
    }
    chrome.storage.local.set({ deviceMap: persistMap }).catch(() => {});
    // Persist per-session state to session storage
    const sessionData: Record<string, { meetingId: string | null; meetingCode: string | null }> = {};
    for (const [sid, s] of sessions) {
      sessionData[sid] = { meetingId: s.meetingId, meetingCode: s.meetingCode };
    }
    chrome.storage.session.set({ sessions: sessionData }).catch(() => {});
  }, 2_000);
}

// Keep the old name as a convenience alias
const scheduleDeviceMapPersist = scheduleSessionPersist;

async function restoreSessionState(): Promise<void> {
  try {
    // Restore deviceMap from persistent local storage, skipping expired entries
    const now = Date.now();
    const local = await chrome.storage.local.get(['deviceMap']);
    if (local.deviceMap && typeof local.deviceMap === 'object') {
      for (const [k, v] of Object.entries(local.deviceMap as Record<string, { name: string; ts: number }>)) {
        if (v && v.name && v.ts && now - v.ts < DEVICE_MAP_TTL_MS) {
          deviceMap.set(k, v);
        }
      }
    }

    // Restore per-session state
    const sessionStorage = await chrome.storage.session.get(['sessions']);
    if (sessionStorage.sessions && typeof sessionStorage.sessions === 'object') {
      const stored = sessionStorage.sessions as Record<string, { meetingId: string | null; meetingCode: string | null }>;
      for (const [sid, data] of Object.entries(stored)) {
        // Only restore if the meeting still exists and is not ended
        if (data.meetingId) {
          const meeting = getMeeting(data.meetingId);
          if (meeting && !meeting.endTime) {
            const s = getOrCreateSession(sid);
            s.meetingId = data.meetingId;
            s.meetingCode = data.meetingCode;
            // Seed transcript store from meeting entries for dedup
            seedSession(sid, meeting.entries);
            updateExtensionIcon(true);
          }
        }
      }
    }
  } catch { /* empty on first load */ }
}

// --- Initialization ---

restoreFromStorage();
// Ensure meetings are loaded before restoring session state, so the
// deviceMap backfill from meeting.participants works reliably.
const sessionStateReady = restoreMeetings().then(() => restoreSessionState());

// Re-route popup for the active Meet tab on SW startup (popup routing is per-tab
// and resets when the service worker restarts).
sessionStateReady.then(async () => {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) await updatePopupForTab(activeTab.id, activeTab.url);
  } catch { /* ignore */ }
});

// --- Extension icon state ---

function updateExtensionIcon(isRecording: boolean): void {
  chrome.action.setTitle({
    title: isRecording ? 'Notula - Recording' : 'Notula',
  });
}

// --- Notula ---

notula.configure((message) => broadcastToPopup(message));

// An update over MeetScribe is told once that the name changed; a fresh
// install is never told about a name it never used.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'update') void notula.noteUpdate(details.previousVersion);
  // An update or a reload empties session storage the same way a browser start does.
  void sessionStateReady.then(sweepOrphans);
});

// The browser started: one of the three occasions the connection is checked,
// and the moment a queue left over from yesterday goes out.
chrome.runtime.onStartup.addListener(() => {
  void sessionStateReady.then(() => {
    sweepOrphans();
    return notula.check();
  });
});

// --- Dynamic popup routing ---

function isMeetTab(url?: string): boolean {
  return !!url && url.includes('meet.google.com');
}

async function updatePopupForTab(tabId: number, url?: string): Promise<void> {
  if (isMeetTab(url)) {
    await chrome.action.setPopup({ tabId, popup: '' });
  } else {
    await chrome.action.setPopup({ tabId, popup: 'popup.html' });
  }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    await updatePopupForTab(activeInfo.tabId, tab.url);
  } catch { /* tab may not exist */ }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    try {
      await updatePopupForTab(tabId, tab.url);
    } catch { /* tab may have been closed */ }
  }
});

// --- Toolbar icon click → toggle popup (only fires when popup is '' i.e. Meet tabs) ---

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id && tab.url?.includes('meet.google.com')) {
    chrome.tabs.sendMessage(tab.id, { type: MSG.TOGGLE_POPUP }).catch(() => {});
  }
});

// --- Port management ---

chrome.runtime.onConnect.addListener((port) => {
  if (port.name.startsWith(KEEPALIVE_PORT_NAME + ':')) {
    const sessionId = port.name.slice(KEEPALIVE_PORT_NAME.length + 1);
    const tabId = port.sender?.tab?.id;
    if (tabId != null) {
      tabSessionMap.set(tabId, sessionId);
    }

    // The tab is back within the grace period: nothing ends.
    void chrome.alarms.clear(END_ALARM + sessionId);

    port.onMessage.addListener(() => {
      // ping received
    });

    port.onDisconnect.addListener(() => {
      const session = sessions.get(sessionId);
      if (session?.meetingCode) {
        // A reload or a dropped connection comes back within the grace; a
        // closed tab does not, and the alarm ends the meeting whether or not
        // this worker is still awake when the time comes.
        void chrome.alarms.create(END_ALARM + sessionId, { when: Date.now() + KEEPALIVE_GRACE_MS });
      }
    });
  } else if (port.name === POPUP_PORT_NAME || port.name.startsWith(POPUP_PORT_NAME + ':')) {
    // Floating popup connecting — prefer sessionId from port name, fall back to tab lookup
    const portSessionId = port.name.includes(':') ? port.name.slice(POPUP_PORT_NAME.length + 1) : undefined;
    const tabId = port.sender?.tab?.id;
    const sessionId = portSessionId || (tabId != null ? tabSessionMap.get(tabId) : undefined);
    popupPorts.set(port, sessionId);

    // Send current state for this session's meeting
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const meeting = session?.meetingId ? getMeeting(session.meetingId) : null;
    const entries = sessionId ? getEntries(sessionId) : [];
    // If transcript-store is empty but meeting has entries (e.g. after SW restart), use meeting entries
    const snapshotEntries = entries.length > 0 ? entries : (meeting?.entries ?? []);
    port.postMessage({
      type: 'meeting_snapshot',
      meeting,
      entries: snapshotEntries,
      notes: meeting?.notes ?? [],
    });

    // The panel opened: what Notula is to it right now, and the check that
    // may change the answer a moment later.
    void sessionStateReady.then(async () => {
      try {
        port.postMessage({ type: 'notula_snapshot', snapshot: await notula.snapshot() });
      } catch { /* port gone */ }
      void notula.check();
    });

    port.onMessage.addListener((message: { type?: unknown }) => {
      if (typeof message?.type === 'string' && message.type.startsWith('notula_')) {
        void notula.handle(message as { type: string } & Record<string, unknown>);
      }
    });

    port.onDisconnect.addListener(() => {
      popupPorts.delete(port);
    });
  }
});

function broadcastToPopup(message: unknown, sessionId?: string): void {
  for (const [port, portSessionId] of popupPorts) {
    // If sessionId specified, only send to matching ports
    if (sessionId && portSessionId !== sessionId) continue;
    try {
      port.postMessage(message);
    } catch {
      popupPorts.delete(port);
    }
  }
}

// --- Meeting lifecycle ---

function requestDeviceRefresh(): void {
  if (deviceRefreshTimer) {
    console.debug('[MeetTranscript] Device refresh already scheduled, skipping');
    return;
  }
  console.debug('[MeetTranscript] Scheduling device refresh in', DEVICE_REFRESH_DEBOUNCE_MS, 'ms');
  deviceRefreshTimer = setTimeout(async () => {
    deviceRefreshTimer = null;
    try {
      const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
      console.debug('[MeetTranscript] Sending device refresh to', tabs.length, 'Meet tabs');
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: MSG.REFRESH_DEVICES }).catch(() => {});
        }
      }
    } catch { /* silent */ }
  }, DEVICE_REFRESH_DEBOUNCE_MS);
}

/** Look up display name for a device ID. The deviceMap is persisted to
 *  chrome.storage.local so it survives SW restarts and extension updates. */
function resolveDeviceName(deviceId: string): string | undefined {
  const entry = deviceMap.get(deviceId);
  if (!entry) return undefined;
  if (Date.now() - entry.ts >= DEVICE_MAP_TTL_MS) {
    deviceMap.delete(deviceId);
    return undefined;
  }
  return entry.name;
}

function ensureMeeting(sessionId: string, meetingCode?: string): string {
  const session = getOrCreateSession(sessionId);

  if (session.meetingId) return session.meetingId;

  const code = meetingCode ?? session.meetingCode ?? 'unknown';

  // Try to resume a recent meeting with the same code (e.g. after a
  // service-worker restart where session storage lost the state).
  const recent = findRecentMeeting(code);
  if (recent) {
    resumeMeeting(recent.id);
    session.meetingId = recent.id;
    session.meetingCode = code;
    // Seed transcript store from meeting entries for dedup
    seedSession(sessionId, recent.entries);
    scheduleSessionPersist();
    updateExtensionIcon(true);
    broadcastToPopup({ type: 'meeting_started', meeting: recent }, sessionId);
    return recent.id;
  }

  // Clear transcript for this session
  clearEntries(sessionId);

  const meeting = createMeeting(code);
  session.meetingId = meeting.id;
  session.meetingCode = code;
  scheduleSessionPersist();
  updateExtensionIcon(true);
  broadcastToPopup({ type: 'meeting_started', meeting }, sessionId);

  // Push the caption language this call was last held in, else the one picked last.
  syncLanguageToMeet(code);

  // Start monitoring for caption data — if none arrives, ask content script to retry enabling captions
  scheduleCaptionStallCheck(sessionId);

  return meeting.id;
}

/**
 * The end of a meeting. One that ends with nothing in it - a call joined by
 * mistake, or one whose captions never came - is dropped rather than kept as
 * an empty card; the rest are closed and offered to Notula.
 */
function finishMeeting(meetingId: string, sessionId?: string): void {
  const meeting = getMeeting(meetingId);
  if (meeting && meeting.entries.length === 0 && meeting.notes.length === 0) {
    deleteMeeting(meetingId);
    broadcastToPopup({ type: 'meeting_ended', meetingId }, sessionId);
    return;
  }
  endMeeting(meetingId);
  broadcastToPopup({ type: 'meeting_ended', meetingId }, sessionId);
  void notula.onMeetingEnded(meetingId);
}

/** The grace ran out with the tab still gone: the meeting ends and the session is forgotten. */
function endSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.meetingId) finishMeeting(session.meetingId, sessionId);
  clearEntries(sessionId);
  sessions.delete(sessionId);
  lastCaptionTime.delete(sessionId);
  const stallTimer = captionStallTimers.get(sessionId);
  if (stallTimer) {
    clearTimeout(stallTimer);
    captionStallTimers.delete(sessionId);
  }
  for (const [tabId, sid] of tabSessionMap) if (sid === sessionId) tabSessionMap.delete(tabId);
  scheduleSessionPersist();
  if (getLiveMeetingIds().length === 0) updateExtensionIcon(false);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(END_ALARM)) return;
  void sessionStateReady.then(() => endSession(alarm.name.slice(END_ALARM.length)));
});

/**
 * A finished meeting with no transcript and no notes is nothing to keep, and
 * one that ended before this rule existed is still on the list: it goes the
 * next time the list is asked for. A live one is left alone, whatever it holds.
 */
function sweepEmpty(): void {
  const live = new Set(getLiveMeetingIds());
  for (const meeting of getMeetings()) {
    if (live.has(meeting.id) || meeting.endTime === null) continue;
    const full = getMeeting(meeting.id);
    if (full && full.entries.length === 0 && full.notes.length === 0) deleteMeeting(meeting.id);
  }
}

/**
 * The browser has just started, so session storage is empty and nothing that
 * is still marked live has a tab behind it: those meetings were left that way
 * by a worker put to sleep before its grace ran out. They end now, and an
 * empty one goes. A tab that has already reconnected keeps its meeting.
 */
function sweepOrphans(): void {
  const live = new Set(getLiveMeetingIds());
  for (const meeting of getMeetings()) {
    if (meeting.endTime === null && !live.has(meeting.id)) finishMeeting(meeting.id);
  }
  sweepEmpty();
}

function scheduleCaptionStallCheck(sessionId: string, attempt = 1): void {
  // Clear any existing timer for this session
  const existing = captionStallTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    captionStallTimers.delete(sessionId);
    const session = sessions.get(sessionId);
    if (!session?.meetingId) return; // meeting ended

    const lastTime = lastCaptionTime.get(sessionId) ?? 0;
    if (lastTime > 0) return; // we've received caption data, all good

    // Thirty seconds and a retry that did not help: the panel says what the
    // transcript reads, instead of standing empty.
    if (attempt > 1) {
      broadcastToPopup({ type: 'captions_missing' }, sessionId);
      return;
    }

    console.debug('[MeetTranscript] No caption data received for session', sessionId, '— requesting caption retry');
    try {
      const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: MSG.RETRY_CAPTIONS }).catch(() => {});
        }
      }
    } catch { /* silent */ }
    scheduleCaptionStallCheck(sessionId, attempt + 1);
  }, CAPTION_STALL_MS);
  captionStallTimers.set(sessionId, timer);
}

function syncLanguageToMeet(code: string): void {
  const settings = getSettings();
  const remembered = settings.languageByCode?.[code];
  const language = remembered ?? settings.language;
  // Meet's own default is English, so the last-picked language is only pushed
  // when it is something else; a language remembered for this call is pushed
  // whatever it is, because the last call may have moved Meet off it.
  if (!language || (remembered === undefined && language === 'en')) return;

  setTimeout(async () => {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, {
            type: MSG.LANGUAGE_CHANGE,
            language,
          }).catch(() => {});
        }
      }
    } catch { /* silent */ }
  }, 5000);
}

// --- Message handling ---

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender, sendResponse);
    return true; // async response
  },
);

async function handleMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  // Ensure deviceMap is restored before processing any messages
  await sessionStateReady;
  const settings = getSettings();

  // Resolve sessionId for messages that need per-session routing
  const msgAny = message as unknown as Record<string, unknown>;
  const sessionId = resolveSessionId(msgAny, sender);

  switch (message.type) {
    case MSG.MEETING_CODE: {
      if (!sessionId) break;
      const msg = message as unknown as { meetingCode: string };
      const session = getOrCreateSession(sessionId);

      if (session.meetingId) {
        const meeting = getMeeting(session.meetingId);

        // If the meeting was created without a proper code, just patch it
        if (meeting && meeting.meetingCode === 'unknown') {
          const title = findTitleByCode(msg.meetingCode) ?? msg.meetingCode;
          updateMeeting(session.meetingId, { meetingCode: msg.meetingCode, title });
          session.meetingCode = msg.meetingCode;
          scheduleSessionPersist();
          broadcastToPopup({ type: 'meeting_started', meeting: getMeeting(session.meetingId) }, sessionId);
          syncLanguageToMeet(msg.meetingCode);
          break;
        }

        // End the previous meeting if the code changed or if this is a fresh page load
        const effectiveCurrentCode = session.meetingCode ?? meeting?.meetingCode;
        const codeChanged = !effectiveCurrentCode || effectiveCurrentCode !== msg.meetingCode;
        const isNewPageLoad = !meeting || (Date.now() - meeting.startTime > MEETING_CODE_DEDUP_MS);
        if (codeChanged || isNewPageLoad) {
          finishMeeting(session.meetingId, sessionId);
          session.meetingId = null;
          if (codeChanged) {
            clearEntries(sessionId);
            session.recentActiveDevices.length = 0;
          } else {
            clearEntries(sessionId);
            session.recentActiveDevices.length = 0;
          }
        }
      }
      session.meetingCode = msg.meetingCode;
      scheduleSessionPersist();
      ensureMeeting(sessionId, msg.meetingCode);
      syncLanguageToMeet(msg.meetingCode);
      break;
    }

    case MSG.CAPTION_SPEAKER_NAME: {
      if (!sessionId) break;
      const session = sessions.get(sessionId);
      if (!session) break;

      const nameMsg = message as unknown as { speakerName: string };
      if (!nameMsg.speakerName) break;

      // Find unnamed devices active within the last 10 seconds
      const now = Date.now();
      const unnamedDevices: Array<{ deviceId: string; timestamp: number }> = [];
      for (const entry of session.recentActiveDevices) {
        if (now - entry.timestamp > 10000) break;
        if (!resolveDeviceName(entry.deviceId) || resolveDeviceName(entry.deviceId) === entry.deviceId) {
          unnamedDevices.push(entry);
        }
      }

      console.debug('[MeetTranscript] Caption speaker name from DOM:', nameMsg.speakerName, '| unnamed devices in window:', unnamedDevices.length, '| recent active devices:', session.recentActiveDevices.length);

      if (unnamedDevices.length !== 1) break;

      const deviceId = unnamedDevices[0].deviceId;
      const deviceName = nameMsg.speakerName;
      deviceMap.set(deviceId, { name: deviceName, ts: Date.now() });
      scheduleDeviceMapPersist();

      // Retroactively fix entries
      const updatedEntries = renameSpeakerByDeviceId(sessionId, deviceId, deviceName);
      for (const updated of updatedEntries) {
        if (session.meetingId) {
          updateEntryText(session.meetingId, updated.id, updated.text);
          updateEntrySpeaker(session.meetingId, updated.id, deviceName);
        }
        broadcastToPopup({ type: 'entry_updated', entry: updated }, sessionId);
      }

      if (session.meetingId) {
        addParticipant(session.meetingId, deviceId, deviceName);
        broadcastToPopup({
          type: 'participant_update',
          deviceId,
          deviceName,
        }, sessionId);
      }
      break;
    }

    case MSG.RTC_DEVICE_INFO: {
      if (!sessionId) break;
      const session = sessions.get(sessionId);

      const devMsg = message as unknown as { deviceId: string; deviceName: string };
      if (devMsg.deviceId && devMsg.deviceName) {
        const oldName = resolveDeviceName(devMsg.deviceId);
        console.debug('[MeetTranscript] Device info received:', devMsg.deviceId, '→', devMsg.deviceName, '| previous:', oldName ?? '(none)', '| deviceMap size:', deviceMap.size);
        deviceMap.set(devMsg.deviceId, { name: devMsg.deviceName, ts: Date.now() });
        scheduleDeviceMapPersist();

        // Retroactively fix entries that used a placeholder or raw deviceId as speaker
        if (!oldName || oldName === devMsg.deviceId) {
          const updatedEntries = renameSpeakerByDeviceId(sessionId, devMsg.deviceId, devMsg.deviceName);
          for (const entry of updatedEntries) {
            if (session?.meetingId) {
              updateEntryText(session.meetingId, entry.id, entry.text);
              updateEntrySpeaker(session.meetingId, entry.id, devMsg.deviceName);
            }
            broadcastToPopup({ type: 'entry_updated', entry }, sessionId);
          }
        }

        if (session?.meetingId) {
          addParticipant(session.meetingId, devMsg.deviceId, devMsg.deviceName);
          broadcastToPopup({
            type: 'participant_update',
            deviceId: devMsg.deviceId,
            deviceName: devMsg.deviceName,
          }, sessionId);
        }
      }
      break;
    }

    case MSG.RTC_CAPTION_DATA: {
      if (!settings.enabled || !sessionId) break;

      const rtcMsg = message as unknown as {
        captions: Array<{ deviceId: string; messageId: string; messageVersion: number; langId: number; text: string }>;
        timestamp: number;
      };

      // Track that we're receiving caption data (used by stall detection)
      lastCaptionTime.set(sessionId, Date.now());

      const meetingId = ensureMeeting(sessionId);
      const session = sessions.get(sessionId)!;

      let hasUnknownDevices = false;
      for (const caption of rtcMsg.captions ?? []) {
        if (!caption.text) continue;

        // Track this device as recently active (for DOM speaker name correlation)
        if (!resolveDeviceName(caption.deviceId)) {
          session.recentActiveDevices.unshift({ deviceId: caption.deviceId, timestamp: Date.now() });
          if (session.recentActiveDevices.length > 10) session.recentActiveDevices.length = 10;
          hasUnknownDevices = true;
          console.debug('[MeetTranscript] Unknown device in caption:', caption.deviceId, '| deviceMap size:', deviceMap.size, '| known devices:', [...deviceMap.keys()].join(', '));
        }

        const speaker = resolveDeviceName(caption.deviceId) ?? caption.deviceId;

        const result = updateOrAddEntry(
          sessionId,
          caption.text,
          speaker,
          caption.messageId,
          caption.messageVersion,
          caption.deviceId,
        );

        if (result) {
          if (result.isUpdate) {
            updateEntryText(meetingId, result.entry.id, result.entry.text);
          } else {
            addTranscriptEntry(meetingId, result.entry);
          }

          broadcastToPopup({
            type: result.isUpdate ? 'entry_updated' : 'new_entry',
            entry: result.entry,
          }, sessionId);
        }
      }

      if (hasUnknownDevices) {
        requestDeviceRefresh();
      }
      break;
    }

    case MSG.RTC_CHAT_MESSAGE: {
      if (!settings.enabled || !sessionId) break;

      const chatMsg = message as unknown as { deviceId: string; messageId: string; text: string; timestamp: number };
      if (!chatMsg.text) break;

      const chatSpeaker = resolveDeviceName(chatMsg.deviceId) ?? chatMsg.deviceId;
      const meetingId = ensureMeeting(sessionId);

      const result = updateOrAddEntry(sessionId, `[Chat] ${chatMsg.text}`, chatSpeaker);
      if (result) {
        if (result.isUpdate) {
          updateEntryText(meetingId, result.entry.id, result.entry.text);
        } else {
          addTranscriptEntry(meetingId, result.entry);
        }
        broadcastToPopup({
          type: result.isUpdate ? 'entry_updated' : 'new_entry',
          entry: result.entry,
        }, sessionId);
      }
      break;
    }

    case MSG.GET_TRANSCRIPT: {
      if (sessionId) {
        sendResponse({ entries: getEntries(sessionId) });
      } else {
        sendResponse({ entries: [] });
      }
      return;
    }

    case MSG.EXPORT_TRANSCRIPT: {
      const payload = message.payload as { format?: string; title?: string };
      const format = payload?.format ?? 'txt';
      const entries = sessionId ? getEntries(sessionId) : [];
      const session = sessionId ? sessions.get(sessionId) : undefined;
      const meetingForExport = session?.meetingId ? getMeeting(session.meetingId) : null;
      const notes = meetingForExport?.notes ?? [];
      const exported = formatExport(entries, format, payload?.title, notes);
      sendResponse({ content: exported, format });
      return;
    }

    case MSG.UPDATE_SETTINGS: {
      const newSettings = updateSettings(message.payload as Record<string, unknown>);
      sendResponse({ settings: newSettings });
      return;
    }

    case MSG.GET_SETTINGS: {
      sendResponse({ settings: getSettings() });
      return;
    }

    case MSG.CLEAR_TRANSCRIPT: {
      if (sessionId) {
        clearEntries(sessionId);
        broadcastToPopup({ type: 'transcript_cleared' }, sessionId);
      }
      sendResponse({ ok: true });
      return;
    }

    case MSG.LANGUAGE_CHANGE: {
      // Relay to content script, which will forward to MAIN world
      const langMsg = message as unknown as { language: string };
      const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, {
            type: MSG.LANGUAGE_CHANGE,
            language: langMsg.language,
          }).catch(() => {});
        }
      }
      // The last language, and the language of this call, by its code.
      const fromTab = sender.tab?.id;
      const code = fromTab != null ? sessions.get(tabSessionMap.get(fromTab) ?? '')?.meetingCode : undefined;
      updateSettings({
        language: langMsg.language,
        ...(code && code !== 'unknown' ? { languageByCode: { ...getSettings().languageByCode, [code]: langMsg.language } } : {}),
      });
      // Save to recent languages list (max 5, deduplicated, most recent first)
      try {
        const stored = await chrome.storage.local.get('recentLanguages');
        const recent: string[] = stored.recentLanguages ?? [];
        const filtered = recent.filter((l: string) => l !== langMsg.language);
        filtered.unshift(langMsg.language);
        await chrome.storage.local.set({ recentLanguages: filtered.slice(0, 5) });
      } catch { /* silent */ }
      sendResponse({ ok: true });
      return;
    }

    case MSG.GET_MEETINGS: {
      sweepEmpty();
      sendResponse({ meetings: getMeetings(), liveMeetingIds: getLiveMeetingIds() });
      return;
    }

    case MSG.RENAME_MEETING: {
      const renameMsg = message.payload as { id: string; title: string };
      const updated = renameMeeting(renameMsg.id, renameMsg.title);
      if (updated) {
        // Broadcast to all popup ports so live view stays in sync
        for (const [sid, session] of sessions) {
          if (session.meetingId === renameMsg.id) {
            broadcastToPopup({ type: 'meeting_renamed', meeting: updated }, sid);
            break;
          }
        }
      }
      sendResponse({ meeting: updated });
      return;
    }

    case MSG.DELETE_MEETING: {
      const deleteMsg = message.payload as { id: string };
      // Prevent deleting a meeting that's currently live in any session
      const liveIds = getLiveMeetingIds();
      if (liveIds.includes(deleteMsg.id)) {
        sendResponse({ ok: false, error: 'Cannot delete a live meeting' });
        return;
      }
      deleteMeeting(deleteMsg.id);
      sendResponse({ ok: true });
      return;
    }

    case MSG.EXPORT_MEETING: {
      const exportMsg = message.payload as { id: string; format?: string };
      const meetingToExport = getMeeting(exportMsg.id);
      if (meetingToExport) {
        const format = exportMsg.format ?? 'md';
        const content = formatExport(meetingToExport.entries, format, meetingToExport.title, meetingToExport.notes ?? []);
        sendResponse({ content, format, title: meetingToExport.title, startTime: meetingToExport.startTime });
      } else {
        sendResponse({ content: null });
      }
      return;
    }

    case MSG.GET_MEETING_TITLES: {
      sendResponse({ titles: getMeetingTitles() });
      return;
    }

    case MSG.GET_CURRENT_MEETING: {
      // Return the meeting for the sender's session (tab)
      const session = sessionId ? sessions.get(sessionId) : undefined;
      const current = session?.meetingId ? getMeeting(session.meetingId) : null;
      sendResponse({ meeting: current });
      return;
    }

    case MSG.GET_MEETING_ENTRIES: {
      const meetingId = (message as unknown as { meetingId: string }).meetingId;
      const meetingData = getMeeting(meetingId);
      sendResponse({ entries: meetingData?.entries ?? [], notes: meetingData?.notes ?? [] });
      return;
    }

    case MSG.ADD_NOTE: {
      const notePayload = message.payload as { meetingId: string; text: string };
      const note = addNote(notePayload.meetingId, notePayload.text);
      if (note) {
        // Broadcast to popup ports so live view stays in sync
        for (const [sid, session] of sessions) {
          if (session.meetingId === notePayload.meetingId) {
            broadcastToPopup({ type: 'note_added', note }, sid);
            break;
          }
        }
      }
      sendResponse({ note });
      return;
    }

    case MSG.UPDATE_NOTE: {
      const updNotePayload = message.payload as { meetingId: string; noteId: string; text: string };
      const updatedNote = updateNote(updNotePayload.meetingId, updNotePayload.noteId, updNotePayload.text);
      if (updatedNote) {
        for (const [sid, session] of sessions) {
          if (session.meetingId === updNotePayload.meetingId) {
            broadcastToPopup({ type: 'note_updated', note: updatedNote }, sid);
            break;
          }
        }
      }
      sendResponse({ note: updatedNote });
      return;
    }

    case MSG.DELETE_NOTE: {
      const delNotePayload = message.payload as { meetingId: string; noteId: string };
      const deleted = deleteNote(delNotePayload.meetingId, delNotePayload.noteId);
      if (deleted) {
        for (const [sid, session] of sessions) {
          if (session.meetingId === delNotePayload.meetingId) {
            broadcastToPopup({ type: 'note_deleted', noteId: delNotePayload.noteId }, sid);
            break;
          }
        }
      }
      sendResponse({ ok: deleted });
      return;
    }

    default:
      if (typeof message.type === 'string' && message.type.startsWith('notula_')) {
        await notula.handle(message as unknown as { type: string } & Record<string, unknown>);
      }
      break;
  }

  sendResponse({ ok: true });
}

function formatExport(entries: TranscriptEntry[], format: string, title?: string, notes?: import('../utils/types').NoteEntry[]): string {
  switch (format) {
    case 'srt': return exportAsSrt(entries);
    case 'vtt': return exportAsVtt(entries);
    case 'json': return exportAsJson(entries);
    case 'md': return exportAsMarkdown(entries, title, notes);
    case 'txt':
    default: return exportAsText(entries, notes);
  }
}
