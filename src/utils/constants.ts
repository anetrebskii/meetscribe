export const KEEPALIVE_INTERVAL_MS = 20_000;
export const STORAGE_DEBOUNCE_MS = 2_000;
export const MEETING_RESUME_WINDOW_MS = 10 * 60_000; // 10 minutes

export const MESSAGE_SOURCE = 'meetscribe';

export const RTC_CHANNEL_NAMES = ['captions', 'meet_messages', 'collections'] as const;
export const RTC_CAPTION_BATCH_MS = 500;

/** Map of Google Meet language IDs to locale codes (matches Tactiq reference) */
export const LANGUAGE_CODES: Record<number, { code: string; name: string }> = {
  1: { code: 'en-US', name: 'English' },
  2: { code: 'es-MX', name: 'Spanish (Mexico)' },
  3: { code: 'es-ES', name: 'Spanish (Spain)' },
  4: { code: 'pt-BR', name: 'Portuguese (Brazil)' },
  5: { code: 'fr-FR', name: 'French' },
  6: { code: 'de-DE', name: 'German' },
  7: { code: 'it-IT', name: 'Italian' },
  8: { code: 'nl-NL', name: 'Dutch' },
  9: { code: 'ja-JP', name: 'Japanese' },
  10: { code: 'ru-RU', name: 'Russian' },
  11: { code: 'ko-KR', name: 'Korean' },
  17: { code: 'pt-PT', name: 'Portuguese (Portugal)' },
  18: { code: 'hi-IN', name: 'Hindi' },
  24: { code: 'sv-SE', name: 'Swedish' },
  25: { code: 'nb-NO', name: 'Norwegian' },
  34: { code: 'cmn-Hans-CN', name: 'Chinese (Simplified)' },
  35: { code: 'cmn-Hant-TW', name: 'Chinese (Traditional)' },
  37: { code: 'th-TH', name: 'Thai' },
  38: { code: 'tr-TR', name: 'Turkish' },
  39: { code: 'pl-PL', name: 'Polish' },
  40: { code: 'ro-RO', name: 'Romanian' },
  41: { code: 'id-ID', name: 'Indonesian' },
  42: { code: 'vi-VN', name: 'Vietnamese' },
  44: { code: 'uk-UA', name: 'Ukrainian' },
  47: { code: 'ar-EG', name: 'Arabic' },
  93: { code: 'cs-CZ', name: 'Czech' },
  94: { code: 'da-DK', name: 'Danish' },
  95: { code: 'fi-FI', name: 'Finnish' },
  101: { code: 'el-GR', name: 'Greek' },
  106: { code: 'hu-HU', name: 'Hungarian' },
  112: { code: 'sk-SK', name: 'Slovak' },
};

/** Reverse lookup: locale code → langId */
export const LOCALE_TO_LANG_ID: Record<string, number> = Object.fromEntries(
  Object.entries(LANGUAGE_CODES).map(([id, { code }]) => [code, Number(id)]),
);
