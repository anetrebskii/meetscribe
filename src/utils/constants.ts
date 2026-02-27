export const KEEPALIVE_INTERVAL_MS = 20_000;
export const STORAGE_DEBOUNCE_MS = 2_000;
export const MEETING_RESUME_WINDOW_MS = 10 * 60_000; // 10 minutes

export const MESSAGE_SOURCE = 'meetscribe';

export const RTC_CHANNEL_NAMES = ['captions', 'meet_messages', 'collections'] as const;
export const RTC_CAPTION_BATCH_MS = 500;

/** Map of Google Meet language IDs to locale codes */
export const LANGUAGE_CODES: Record<number, { code: string; name: string }> = {
  1: { code: 'en', name: 'English' },
  2: { code: 'es', name: 'Spanish' },
  3: { code: 'fr', name: 'French' },
  4: { code: 'de', name: 'German' },
  5: { code: 'pt', name: 'Portuguese' },
  6: { code: 'ja', name: 'Japanese' },
  7: { code: 'zh', name: 'Chinese' },
  8: { code: 'ar', name: 'Arabic' },
  9: { code: 'ru', name: 'Russian' },
  10: { code: 'hi', name: 'Hindi' },
  11: { code: 'it', name: 'Italian' },
  12: { code: 'ko', name: 'Korean' },
  13: { code: 'nl', name: 'Dutch' },
  14: { code: 'pl', name: 'Polish' },
  15: { code: 'sv', name: 'Swedish' },
  16: { code: 'tr', name: 'Turkish' },
  17: { code: 'vi', name: 'Vietnamese' },
  18: { code: 'th', name: 'Thai' },
  19: { code: 'id', name: 'Indonesian' },
  20: { code: 'cs', name: 'Czech' },
  21: { code: 'da', name: 'Danish' },
  22: { code: 'fi', name: 'Finnish' },
  23: { code: 'el', name: 'Greek' },
  24: { code: 'hu', name: 'Hungarian' },
  25: { code: 'no', name: 'Norwegian' },
  26: { code: 'ro', name: 'Romanian' },
  27: { code: 'sk', name: 'Slovak' },
  28: { code: 'uk', name: 'Ukrainian' },
};

/** Reverse lookup: locale code → langId */
export const LOCALE_TO_LANG_ID: Record<string, number> = Object.fromEntries(
  Object.entries(LANGUAGE_CODES).map(([id, { code }]) => [code, Number(id)]),
);
