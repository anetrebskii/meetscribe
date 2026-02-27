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
  getSettings,
  updateSettings,
  restoreFromStorage,
  renameSpeaker,
  exportAsText,
  exportAsSrt,
  exportAsVtt,
  exportAsJson,
  exportAsMarkdown,
} from '../utils/transcript-store';
import {
  createMeeting,
  getCurrentMeeting,
  getCurrentMeetingId,
  addParticipant,
  addTranscriptEntry,
  updateEntryText,
  updateEntrySpeaker,
  endMeeting,
  getMeetings,
  getMeeting,
  renameMeeting,
  deleteMeeting,
  restoreMeetings,
  setCurrentMeetingId,
  getMeetingTitles,
} from '../utils/meeting-store';

// --- State ---

const popupPorts = new Set<chrome.runtime.Port>();
const deviceMap = new Map<string, string>(); // deviceId → display name
let currentMeetingCode: string | null = null;
// Track recently active device IDs for DOM-based speaker name correlation
const recentActiveDevices: Array<{ deviceId: string; timestamp: number }> = [];
let keepaliveDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
const KEEPALIVE_GRACE_MS = 120_000; // 2 minutes grace before ending meeting

// --- Initialization ---

restoreFromStorage();
restoreMeetings();

// --- Extension icon state ---

function updateExtensionIcon(isRecording: boolean): void {
  chrome.action.setTitle({
    title: isRecording ? 'MeetScribe - Recording' : 'MeetScribe',
  });
}

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
    await updatePopupForTab(tabId, tab.url);
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
  if (port.name === KEEPALIVE_PORT_NAME) {
    // Cancel pending disconnect timer — tab reconnected
    if (keepaliveDisconnectTimer) {
      clearTimeout(keepaliveDisconnectTimer);
      keepaliveDisconnectTimer = null;
    }
    port.onMessage.addListener(() => {
      // ping received
    });
    port.onDisconnect.addListener(() => {
      // Don't end immediately — tab may be backgrounded (timers throttled).
      // Wait for a grace period; if no reconnect, then end.
      if (currentMeetingCode) {
        const code = currentMeetingCode;
        keepaliveDisconnectTimer = setTimeout(() => {
          keepaliveDisconnectTimer = null;
          // Only end if no new keepalive reconnected in the meantime
          if (currentMeetingCode === code) {
            const meetingId = getCurrentMeetingId();
            if (meetingId) {
              endMeeting(meetingId);
              broadcastToPopup({ type: 'meeting_ended', meetingId });
            }
            currentMeetingCode = null;
            updateExtensionIcon(false);
          }
        }, KEEPALIVE_GRACE_MS);
      }
    });
  } else if (port.name === POPUP_PORT_NAME) {
    popupPorts.add(port);

    // Send current state
    const meeting = getCurrentMeeting();
    port.postMessage({
      type: 'meeting_snapshot',
      meeting,
      entries: getEntries(),
    });

    port.onDisconnect.addListener(() => {
      popupPorts.delete(port);
    });
  }
});

function broadcastToPopup(message: unknown): void {
  for (const port of popupPorts) {
    try {
      port.postMessage(message);
    } catch {
      popupPorts.delete(port);
    }
  }
}

// --- Meeting lifecycle ---

function ensureMeeting(meetingCode?: string): string {
  const existingId = getCurrentMeetingId();
  if (existingId) return existingId;

  // Clear stale state from previous meeting
  clearEntries();
  deviceMap.clear();
  recentActiveDevices.length = 0;

  const code = meetingCode ?? currentMeetingCode ?? 'unknown';
  const meeting = createMeeting(code);
  currentMeetingCode = code;
  updateExtensionIcon(true);
  broadcastToPopup({ type: 'meeting_started', meeting });
  return meeting.id;
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
  const settings = getSettings();

  switch (message.type) {
    case MSG.MEETING_CODE: {
      const msg = message as unknown as { meetingCode: string };
      currentMeetingCode = msg.meetingCode;
      // Create meeting immediately so it appears in the list before anyone speaks
      ensureMeeting(msg.meetingCode);
      break;
    }

    case MSG.CAPTION_SPEAKER_NAME: {
      // Speaker name extracted from native Google Meet caption DOM
      const nameMsg = message as unknown as { speakerName: string };
      if (!nameMsg.speakerName) break;

      // Find unnamed devices active within the last 10 seconds
      const now = Date.now();
      const unnamedDevices: Array<{ deviceId: string; timestamp: number }> = [];
      for (const entry of recentActiveDevices) {
        if (now - entry.timestamp > 10000) break;
        if (!deviceMap.has(entry.deviceId) || deviceMap.get(entry.deviceId) === entry.deviceId) {
          unnamedDevices.push(entry);
        }
      }

      // Only assign if exactly one unnamed device — avoids mismatching
      if (unnamedDevices.length !== 1) break;

      const deviceId = unnamedDevices[0].deviceId;
      const deviceName = nameMsg.speakerName;
      deviceMap.set(deviceId, deviceName);

      // Retroactively fix entries
      const updatedEntries = renameSpeaker(deviceId, deviceName);
      for (const updated of updatedEntries) {
        const meetingId = getCurrentMeetingId();
        if (meetingId) {
          updateEntryText(meetingId, updated.id, updated.text);
          updateEntrySpeaker(meetingId, updated.id, deviceName);
        }
        broadcastToPopup({ type: 'entry_updated', entry: updated });
      }

      const meetingId = getCurrentMeetingId();
      if (meetingId) {
        addParticipant(meetingId, deviceId, deviceName);
        broadcastToPopup({
          type: 'participant_update',
          deviceId,
          deviceName,
        });
      }
      break;
    }

    case MSG.RTC_DEVICE_INFO: {
      const devMsg = message as unknown as { deviceId: string; deviceName: string };
      if (devMsg.deviceId && devMsg.deviceName) {
        const oldName = deviceMap.get(devMsg.deviceId);
        deviceMap.set(devMsg.deviceId, devMsg.deviceName);

        // Retroactively fix entries that used the raw deviceId as speaker
        if (!oldName || oldName === devMsg.deviceId) {
          const updatedEntries = renameSpeaker(devMsg.deviceId, devMsg.deviceName);
          for (const entry of updatedEntries) {
            const meetingId = getCurrentMeetingId();
            if (meetingId) {
              updateEntryText(meetingId, entry.id, entry.text);
              // Also fix speaker in meeting-store
              updateEntrySpeaker(meetingId, entry.id, devMsg.deviceName);
            }
            broadcastToPopup({ type: 'entry_updated', entry });
          }
        }

        const meetingId = getCurrentMeetingId();
        if (meetingId) {
          addParticipant(meetingId, devMsg.deviceId, devMsg.deviceName);
          broadcastToPopup({
            type: 'participant_update',
            deviceId: devMsg.deviceId,
            deviceName: devMsg.deviceName,
          });
        }
      }
      break;
    }

    case MSG.RTC_CAPTION_DATA: {
      if (!settings.enabled) break;

      const rtcMsg = message as unknown as {
        captions: Array<{ deviceId: string; messageId: string; messageVersion: number; langId: number; text: string }>;
        timestamp: number;
      };

      const meetingId = ensureMeeting();

      for (const caption of rtcMsg.captions ?? []) {
        if (!caption.text) continue;

        // Track this device as recently active (for DOM speaker name correlation)
        if (!deviceMap.has(caption.deviceId)) {
          recentActiveDevices.unshift({ deviceId: caption.deviceId, timestamp: Date.now() });
          // Keep only last 10 entries
          if (recentActiveDevices.length > 10) recentActiveDevices.length = 10;
        }

        const speaker = deviceMap.get(caption.deviceId) ?? caption.deviceId;

        const result = updateOrAddEntry(
          caption.text,
          speaker,
          caption.messageId,
          caption.messageVersion,
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
          });
        }
      }
      break;
    }

    case MSG.RTC_CHAT_MESSAGE: {
      if (!settings.enabled) break;

      const chatMsg = message as unknown as { deviceId: string; messageId: string; text: string; timestamp: number };
      if (!chatMsg.text) break;

      const chatSpeaker = deviceMap.get(chatMsg.deviceId) ?? chatMsg.deviceId;
      const meetingId = ensureMeeting();

      const result = updateOrAddEntry(`[Chat] ${chatMsg.text}`, chatSpeaker);
      if (result) {
        if (result.isUpdate) {
          updateEntryText(meetingId, result.entry.id, result.entry.text);
        } else {
          addTranscriptEntry(meetingId, result.entry);
        }
        broadcastToPopup({
          type: result.isUpdate ? 'entry_updated' : 'new_entry',
          entry: result.entry,
        });
      }
      break;
    }

    case MSG.GET_TRANSCRIPT: {
      sendResponse({ entries: getEntries() });
      return;
    }

    case MSG.EXPORT_TRANSCRIPT: {
      const payload = message.payload as { format?: string; title?: string };
      const format = payload?.format ?? 'txt';
      const entries = getEntries();
      const exported = formatExport(entries, format, payload?.title);
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
      clearEntries();
      broadcastToPopup({ type: 'transcript_cleared' });
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
      // Update settings with last language
      updateSettings({ language: langMsg.language });
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
      sendResponse({ meetings: getMeetings(), currentMeetingId: getCurrentMeetingId() });
      return;
    }

    case MSG.RENAME_MEETING: {
      const renameMsg = message.payload as { id: string; title: string };
      const updated = renameMeeting(renameMsg.id, renameMsg.title);
      sendResponse({ meeting: updated });
      return;
    }

    case MSG.DELETE_MEETING: {
      const deleteMsg = message.payload as { id: string };
      if (deleteMsg.id === getCurrentMeetingId()) {
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
        const content = formatExport(meetingToExport.entries, format, meetingToExport.title);
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
      const current = getCurrentMeeting();
      sendResponse({ meeting: current });
      return;
    }

    case MSG.GET_MEETING_ENTRIES: {
      const meetingId = (message as unknown as { meetingId: string }).meetingId;
      const meetingData = getMeeting(meetingId);
      sendResponse({ entries: meetingData?.entries ?? [] });
      return;
    }

    default:
      break;
  }

  sendResponse({ ok: true });
}

function formatExport(entries: TranscriptEntry[], format: string, title?: string): string {
  switch (format) {
    case 'srt': return exportAsSrt(entries);
    case 'vtt': return exportAsVtt(entries);
    case 'json': return exportAsJson(entries);
    case 'md': return exportAsMarkdown(entries, title);
    case 'txt':
    default: return exportAsText(entries);
  }
}
