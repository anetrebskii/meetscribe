export interface TranscriptEntry {
  id: string;
  text: string;
  speaker: string;
  timestamp: number;
  messageId?: string;
}

export interface Meeting {
  id: string;
  meetingCode: string;
  title: string;
  description: string;
  startTime: number;
  endTime: number | null;
  participants: Record<string, string>; // deviceId → name
  entries: TranscriptEntry[];
}

export interface RtcCaptionMessage {
  deviceId: string;
  messageId: string;
  messageVersion: number;
  langId: number;
  text: string;
}

export interface RtcCaptionPayload {
  type: typeof MSG.RTC_CAPTION_DATA;
  captions: RtcCaptionMessage[];
  timestamp: number;
}

export interface RtcDeviceInfoPayload {
  type: typeof MSG.RTC_DEVICE_INFO;
  deviceId: string;
  deviceName: string;
}

export interface RtcChatPayload {
  type: typeof MSG.RTC_CHAT_MESSAGE;
  deviceId: string;
  messageId: string;
  text: string;
  timestamp: number;
}

export const MSG = {
  RTC_CAPTION_DATA: 'rtc_caption_data',
  RTC_DEVICE_INFO: 'rtc_device_info',
  RTC_CHAT_MESSAGE: 'rtc_chat_message',
  MEETING_CODE: 'meeting_code',
  GET_TRANSCRIPT: 'get_transcript',
  EXPORT_TRANSCRIPT: 'export_transcript',
  UPDATE_SETTINGS: 'update_settings',
  GET_SETTINGS: 'get_settings',
  CLEAR_TRANSCRIPT: 'clear_transcript',
  INTERCEPTOR_READY: 'interceptor_ready',
  LANGUAGE_CHANGE: 'language_change',
  GET_MEETINGS: 'get_meetings',
  RENAME_MEETING: 'rename_meeting',
  GET_CURRENT_MEETING: 'get_current_meeting',
  TOGGLE_POPUP: 'toggle_popup',
  GET_MEETING_ENTRIES: 'get_meeting_entries',
  CAPTION_SPEAKER_NAME: 'caption_speaker_name',
  DELETE_MEETING: 'delete_meeting',
  EXPORT_MEETING: 'export_meeting',
  GET_MEETING_TITLES: 'get_meeting_titles',
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

export interface ExtensionMessage {
  type: MessageType;
  payload?: unknown;
}

export interface Settings {
  enabled: boolean;
  dedupeWindowMs: number;
  language: string;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  dedupeWindowMs: 5000,
  language: 'en',
};

export const KEEPALIVE_PORT_NAME = 'meet-keepalive';
export const POPUP_PORT_NAME = 'floating-popup';
