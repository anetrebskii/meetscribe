import { MESSAGE_SOURCE, RTC_CHANNEL_NAMES, RTC_CAPTION_BATCH_MS, LOCALE_TO_LANG_ID } from '../utils/constants';
import { parseCaptionMessage, parseDeviceInfo, parseDeviceCollection, parseChatMessage, dumpAllStrings } from '../utils/rtc-message-parser';
import { decodeProtobuf, extractAllStrings } from '../utils/protobuf-decoder';
import { encodeUpdateMediaSession, encodeRtcLanguageChange } from '../utils/protobuf-encoder';
import { textFitsLanguage } from '../utils/language-script';
import { MSG, type RtcCaptionMessage } from '../utils/types';

(function () {
  const w = window as unknown as Record<string, unknown>;
  if (w.__meetInterceptorLoaded) return;
  w.__meetInterceptorLoaded = true;

  const LOG_PREFIX = '[MeetTranscript]';
  const DEBUG = true;

  function log(...args: unknown[]): void {
    console.log(LOG_PREFIX, ...args);
  }

  function debug(...args: unknown[]): void {
    if (DEBUG) console.log(LOG_PREFIX, '[DEBUG]', ...args);
  }

  function postToContentScript(data: unknown): void {
    try {
      window.postMessage({ source: MESSAGE_SOURCE, ...data as object }, '*');
    } catch { /* silent */ }
  }

  // ========================================
  // Extract meeting code from URL and post it
  // ========================================

  function extractMeetingCode(): string | null {
    const match = window.location.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/);
    return match ? match[1] : null;
  }

  let lastMeetingCode = extractMeetingCode();
  if (lastMeetingCode) {
    // Post immediately and also after a short delay (in case content script isn't ready yet)
    postToContentScript({ type: MSG.MEETING_CODE, meetingCode: lastMeetingCode });
    setTimeout(() => postToContentScript({ type: MSG.MEETING_CODE, meetingCode: lastMeetingCode! }), 1000);
  }

  // Detect SPA navigations (URL changes without full page reload) so the
  // service worker learns about the new meeting code.
  function onUrlChange(): void {
    const code = extractMeetingCode();
    if (code && code !== lastMeetingCode) {
      lastMeetingCode = code;
      debug('URL changed, new meeting code:', code);
      postToContentScript({ type: MSG.MEETING_CODE, meetingCode: code });
    }
  }

  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function (...args: Parameters<typeof origPushState>) {
    origPushState.apply(this, args);
    onUrlChange();
  };
  history.replaceState = function (...args: Parameters<typeof origReplaceState>) {
    origReplaceState.apply(this, args);
    onUrlChange();
  };
  window.addEventListener('popstate', onUrlChange);

  // ========================================
  // Caption language
  // ========================================

  let capturedSessionId: string | null = null;
  let capturedHeaders: Record<string, string> = {};
  // The caption language this call is meant to be in. It is kept for the life
  // of the page and sent again whenever a transport appears, whenever Meet
  // announces a different one of its own, and whenever the captions that
  // arrive are in some other language.
  let wantedLanguage: string | null = null;
  let sentLanguage: string | null = null;
  let lastPushAt = 0;
  let httpSentFor: string | null = null;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let mediaSessionChannel: RTCDataChannel | null = null;
  let mediaSessionOpenedAt = 0;
  let captionsEnablingAt = 0;
  // Re-sends on top of Meet's own announcement, and after captions in another
  // language: each is budgeted, so a language the user picks inside Meet
  // that this page failed to notice is not fought for long.
  let overrides = 0;
  let retries = 0;
  const mismatched = new Set<string>();
  const ENABLING_WINDOW_MS = 8_000;
  const CHANNEL_OPEN_WINDOW_MS = 10_000;
  const RETRY_GAP_MS = 15_000;
  const MAX_OVERRIDES = 3;
  const MAX_RETRIES = 3;
  // Captured SyncMeetingSpaceCollections request for replaying on device refresh
  let capturedSyncBody: ArrayBuffer | null = null;
  let capturedSyncUrl: string | null = null;
  let lastDeviceRefreshTime = 0;
  const DEVICE_REFRESH_COOLDOWN_MS = 10_000; // Don't re-fetch more often than every 10s
  // Saved early — the actual monkey-patch happens later in the RTC section
  const origDCSend = RTCDataChannel.prototype.send as (this: RTCDataChannel, data: string | ArrayBuffer | Blob | ArrayBufferView) => void;

  // Fetch intercept — capture session context + extract device names from API responses
  const originalFetch = window.fetch;

  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url = '';
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      // Capture headers and session from any Google Meet $rpc API call
      if (url.includes('meet.google.com/$rpc/') || url.includes('meet.google.com/hangouts/')) {
        if (init?.headers) {
          const headerObj: Record<string, string> = {};
          if (init.headers instanceof Headers) {
            init.headers.forEach((value, key) => { headerObj[key] = value; });
          } else if (Array.isArray(init.headers)) {
            for (const [key, value] of init.headers) { headerObj[key] = value; }
          } else {
            // Normalize keys to lowercase for plain objects
            for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
              headerObj[key.toLowerCase()] = value;
            }
          }
          capturedHeaders = headerObj;
          nudgeLanguage('headers captured');
        }

        // Try to extract session ID from request body.
        // Any $rpc call may carry a mediasessions/ resource name in its protobuf payload.
        if (init?.body) {
          try {
            let raw: Uint8Array | null = null;
            if (init.body instanceof ArrayBuffer) raw = new Uint8Array(init.body);
            else if (init.body instanceof Uint8Array) raw = init.body;
            else if (typeof init.body === 'string') raw = new TextEncoder().encode(init.body);

            if (raw) {
              const bodyStr = new TextDecoder('utf-8', { fatal: false }).decode(raw);
              // Prefer explicit mediasessions/ resource name (present in many $rpc calls)
              const resourceMatch = bodyStr.match(/mediasessions\/([\w-]+)/);
              if (resourceMatch) {
                capturedSessionId = resourceMatch[1];
                debug('Captured session ID from request:', capturedSessionId);
                nudgeLanguage('session captured');
              } else if (url.includes('CreateMeetingDevice') && !capturedSessionId) {
                // CreateMeetingDevice carries a raw 28-char session ID (no mediasessions/ prefix)
                const tokenMatch = bodyStr.match(/\b[A-Za-z0-9_-]{28}\b/);
                if (tokenMatch) {
                  capturedSessionId = tokenMatch[0];
                  debug('Captured session ID from CreateMeetingDevice:', capturedSessionId);
                  nudgeLanguage('session captured');
                }
              } else if (url.includes('GetMediaSession') && !capturedSessionId) {
                // Fall back to 20-40 char alphanumeric token (only for MediaSession URLs)
                const tokenMatch = bodyStr.match(/[A-Za-z0-9_-]{20,40}/);
                if (tokenMatch) {
                  capturedSessionId = tokenMatch[0];
                  debug('Captured session ID (fallback) from request:', capturedSessionId);
                  nudgeLanguage('session captured');
                }
              }
            }
          } catch { /* not text / decode error */ }
        }

        // Capture SyncMeetingSpaceCollections request body for later replay
        if (url.includes('SyncMeetingSpaceCollections') && init?.body) {
          try {
            if (init.body instanceof ArrayBuffer) {
              capturedSyncBody = init.body.slice(0);
            } else if (init.body instanceof Uint8Array) {
              capturedSyncBody = (init.body.buffer as ArrayBuffer).slice(init.body.byteOffset, init.body.byteOffset + init.body.byteLength);
            } else if (typeof init.body === 'string') {
              capturedSyncBody = new TextEncoder().encode(init.body).buffer as ArrayBuffer;
            }
            capturedSyncUrl = url;
            debug('Captured SyncMeetingSpaceCollections request body for replay');
          } catch { /* silent */ }
        }

        debug('Captured API context from', url.split('/').pop());
      }
    } catch { /* silent */ }

    return originalFetch.call(this, input, init).then((response: Response) => {
      try {
        // Intercept SyncMeetingSpaceCollections response to get participant device info
        if (url.includes('SyncMeetingSpaceCollections')) {
          response.clone().text().then(text => {
            try {
              // Response is base64-encoded protobuf
              const binaryStr = atob(text);
              const data = Uint8Array.from(binaryStr, c => c.charCodeAt(0));
              const devices = parseDeviceCollection(data);
              if (devices.length > 0) {
                debug('API: SyncMeetingSpaceCollections returned', devices.length, 'devices');
                for (const d of devices) {
                  debug('API: premeeting device', d.deviceId, '→', d.deviceName);
                  postToContentScript({
                    type: MSG.RTC_DEVICE_INFO,
                    deviceId: d.deviceId,
                    deviceName: d.deviceName,
                  });
                }
              } else {
                debug('API: SyncMeetingSpaceCollections response but no devices parsed, length:', data.length);
                // Dump strings for debugging
                const strings = dumpAllStrings(data);
                if (strings.length > 0) {
                  debug('API: response strings:', strings.slice(0, 20));
                }
              }
            } catch (e) {
              debug('API: failed to decode SyncMeetingSpaceCollections response', e);
            }
          }).catch(() => {});
        }

        // Intercept GetMediaSession response to extract the authoritative session name
        if (url.includes('GetMediaSession')) {
          response.clone().arrayBuffer().then(buffer => {
            try {
              const data = new Uint8Array(buffer);
              // Try raw binary first
              let decoded = new TextDecoder('utf-8', { fatal: false }).decode(data);
              // If it looks base64, decode it
              if (/^[A-Za-z0-9+/=\r\n]+$/.test(decoded.trim()) && decoded.length < data.length * 2) {
                try {
                  const bin = atob(decoded.trim());
                  decoded = bin;
                } catch { /* not base64 */ }
              }
              const match = decoded.match(/mediasessions\/([\w-]+)/);
              if (match) {
                capturedSessionId = match[1];
                debug('API: GetMediaSession — captured session ID:', capturedSessionId);
                nudgeLanguage('session captured');
              } else {
                debug('API: GetMediaSession — no session ID found, raw length:', data.length);
              }
            } catch (e) {
              debug('API: GetMediaSession response parse failed:', e);
            }
          }).catch(() => {});
        }

        // Also intercept CreateMeetingDevice response
        if (url.includes('CreateMeetingDevice')) {
          response.clone().text().then(text => {
            try {
              debug('API: CreateMeetingDevice response length:', text.length, 'first 80 chars:', text.substring(0, 80));
              const binaryStr = atob(text);
              const data = Uint8Array.from(binaryStr, c => c.charCodeAt(0));
              const device = parseDeviceInfo(data);
              if (device) {
                debug('API: CreateMeetingDevice returned', device.deviceId, '→', device.deviceName);
                postToContentScript({
                  type: MSG.RTC_DEVICE_INFO,
                  deviceId: device.deviceId,
                  deviceName: device.deviceName,
                });
              } else {
                debug('API: CreateMeetingDevice no device parsed, dumping strings');
                const strings = dumpAllStrings(data);
                debug('API: CreateMeetingDevice strings:', strings.slice(0, 20));
              }
            } catch (e) {
              debug('API: CreateMeetingDevice decode failed:', e);
            }
          }).catch(() => {});
        }
      } catch { /* silent */ }

      return response;
    });
  };

  // Listen for language change and device refresh requests from content script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== MESSAGE_SOURCE) return;

    if (event.data.type === MSG.LANGUAGE_CHANGE) {
      const langCode = event.data.language as string;
      debug('Language change requested:', langCode);
      setWantedLanguage(langCode);
      applyLanguage('requested');
    } else if (event.data.type === MSG.CAPTIONS_ENABLING) {
      captionsEnablingAt = Date.now();
    } else if (event.data.type === MSG.REFRESH_DEVICES) {
      refreshDeviceInfo();
    }
  });

  function persistLanguageCode(langCode: string): void {
    try {
      const entry = Object.entries(localStorage)
        .find(([key]) => key.includes('rt_g3jartmcups-'));
      if (!entry) return;
      const [key, value] = entry;
      const data = JSON.parse(value);
      data[2] = langCode;
      localStorage.setItem(key, JSON.stringify(data));
      debug('Persisted language code to localStorage key', key);
    } catch (e) {
      debug('Failed to persist language code:', e);
    }
  }

  function setWantedLanguage(langCode: string): void {
    wantedLanguage = langCode;
    overrides = 0;
    retries = 0;
    mismatched.clear();
  }

  /** A transport turned up: the wanted language goes out if it has not yet. */
  function nudgeLanguage(reason: string): void {
    if (wantedLanguage && sentLanguage !== wantedLanguage) applyLanguage(reason);
  }

  function schedulePush(delayMs: number, reason: string): void {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      applyLanguage(reason);
    }, delayMs);
  }

  /**
   * The wanted language goes to Meet over whichever transport is up: the
   * media-session channel, else UpdateMediaSession once per session. Meet's
   * own stored preference is written first, so captions Meet turns on by
   * itself start in this language too.
   */
  function applyLanguage(reason: string): void {
    if (!wantedLanguage) return;
    const langCode = wantedLanguage;
    persistLanguageCode(langCode);

    if (mediaSessionChannel && mediaSessionChannel.readyState === 'open') {
      try {
        const body = encodeRtcLanguageChange(langCode);
        origDCSend.call(mediaSessionChannel, body.buffer as ArrayBuffer);
        sentLanguage = langCode;
        lastPushAt = Date.now();
        debug('Language', langCode, 'sent via media-session channel:', reason);
        return;
      } catch (e) {
        debug('RTC language change failed, trying HTTP fallback:', e);
      }
    }

    if (!capturedSessionId || !capturedHeaders['authorization']) {
      debug('No transport for language yet, holding', langCode, '-', reason);
      return;
    }
    const key = `${capturedSessionId}:${langCode}`;
    if (httpSentFor === key) return;
    httpSentFor = key;
    sentLanguage = langCode;
    lastPushAt = Date.now();
    void sendUpdateMediaSession(capturedSessionId, langCode);
  }

  /** A media-session channel, from whichever side opened it: the language follows a second after it opens. */
  function watchMediaSession(channel: RTCDataChannel): void {
    if (mediaSessionChannel === channel) return;
    mediaSessionChannel = channel;
    const opened = () => {
      if (mediaSessionChannel !== channel) return;
      mediaSessionOpenedAt = Date.now();
      overrides = 0;
      debug('RTC: media-session channel open (id=' + channel.id + '), language will follow');
      schedulePush(1000, 'channel open');
    };
    if (channel.readyState === 'open') opened();
    else channel.addEventListener('open', opened);
    channel.addEventListener('close', () => {
      if (mediaSessionChannel === channel) mediaSessionChannel = null;
    });
  }

  function dialogOpen(): boolean {
    const panels = document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]');
    return Array.from(panels).some(el => el.getClientRects().length > 0);
  }

  /**
   * Meet just told the server a caption language of its own. Within moments of
   * captions being turned on, or of a new channel, that is Meet's stored
   * default, and ours goes out right after it. With a dialog open it is the
   * user's pick inside Meet, and becomes ours. Anything else is left to the
   * captions themselves to settle.
   */
  function noteMeetCaptionConfig(bytes: Uint8Array): void {
    let values: string[];
    try {
      values = extractAllStrings(decodeProtobuf(bytes)).map(s => s.value);
    } catch {
      return;
    }
    if (!values.includes('client_config.caption_config')) return;
    const lang = values.find(v => v in LOCALE_TO_LANG_ID);
    if (!lang) {
      debug('Meet caption config without a known language:', values);
      return;
    }
    if (lang === wantedLanguage) {
      debug('Meet announced the wanted caption language', lang);
      return;
    }
    const now = Date.now();
    const auto = now - captionsEnablingAt < ENABLING_WINDOW_MS || now - mediaSessionOpenedAt < CHANNEL_OPEN_WINDOW_MS;
    if (auto && wantedLanguage) {
      if (overrides >= MAX_OVERRIDES) return;
      overrides++;
      debug('Meet announced its own caption language', lang, '- sending', wantedLanguage, 'after it');
      schedulePush(300, 'after Meet');
      return;
    }
    if (dialogOpen()) {
      debug('Caption language picked inside Meet:', lang);
      setWantedLanguage(lang);
      sentLanguage = lang;
      postToContentScript({ type: MSG.LANGUAGE_OBSERVED, language: lang });
      return;
    }
    debug('Meet announced caption language', lang, 'while', wantedLanguage, 'is wanted; the captions will tell');
  }

  /**
   * The captions say what language they are in, by id, or failing that by
   * script. Three in a row in another language mean the change did not take,
   * and it is sent again, a few times at most.
   */
  function checkCaptionLanguage(caption: RtcCaptionMessage): void {
    if (!wantedLanguage || caption.text.length < 8) return;
    const wantedId = LOCALE_TO_LANG_ID[wantedLanguage];
    const fits = caption.langId && wantedId
      ? caption.langId === wantedId
      : textFitsLanguage(caption.text, wantedLanguage);
    if (fits) {
      mismatched.clear();
      return;
    }
    mismatched.add(caption.messageId);
    if (mismatched.size < 3) return;
    if (retries >= MAX_RETRIES || Date.now() - lastPushAt < RETRY_GAP_MS) return;
    retries++;
    mismatched.clear();
    debug('Captions arrive in another language (langId', caption.langId + '), sending', wantedLanguage, 'again, retry', retries);
    applyLanguage('captions in another language');
  }

  async function sendUpdateMediaSession(sessionId: string, langCode: string): Promise<void> {
    try {
      const body = encodeUpdateMediaSession(sessionId, langCode);
      const url = `https://meet.google.com/$rpc/google.rtc.meetings.v1.MediaSessionService/UpdateMediaSession`;
      debug('UpdateMediaSession → sessionId:', sessionId, 'lang:', langCode, 'content-type:', capturedHeaders['content-type']);
      const resp = await originalFetch.call(window, url, {
        method: 'POST',
        headers: capturedHeaders,
        body: body.buffer as ArrayBuffer,
      });
      if (!resp.ok) {
        const errorBody = await resp.text().catch(() => '(unreadable)');
        debug('Language change failed:', resp.status, resp.statusText, 'body:', errorBody);
      } else {
        debug('Language change API call sent for', langCode);
      }
    } catch (e) {
      debug('Language change API call failed:', e);
    }
  }

  async function refreshDeviceInfo(): Promise<void> {
    const now = Date.now();
    if (now - lastDeviceRefreshTime < DEVICE_REFRESH_COOLDOWN_MS) {
      debug('Device refresh skipped — cooldown');
      return;
    }
    lastDeviceRefreshTime = now;

    if (!capturedSyncBody || !capturedSyncUrl || !capturedHeaders['authorization']) {
      debug('Cannot refresh devices — no captured SyncMeetingSpaceCollections request');
      return;
    }

    try {
      debug('Refreshing device info via SyncMeetingSpaceCollections replay');
      const resp = await originalFetch.call(window, capturedSyncUrl, {
        method: 'POST',
        headers: capturedHeaders,
        body: capturedSyncBody,
      });

      if (!resp.ok) {
        debug('Device refresh failed:', resp.status, resp.statusText);
        return;
      }

      const text = await resp.text();
      const binaryStr = atob(text);
      const data = Uint8Array.from(binaryStr, c => c.charCodeAt(0));
      const devices = parseDeviceCollection(data);

      if (devices.length > 0) {
        debug('Device refresh returned', devices.length, 'devices');
        for (const d of devices) {
          debug('Device refresh:', d.deviceId, '→', d.deviceName);
          postToContentScript({
            type: MSG.RTC_DEVICE_INFO,
            deviceId: d.deviceId,
            deviceName: d.deviceName,
          });
        }
      } else {
        debug('Device refresh: no devices parsed from response');
        const strings = dumpAllStrings(data);
        if (strings.length > 0) {
          debug('Device refresh response strings:', strings.slice(0, 20));
        }
      }
    } catch (e) {
      debug('Device refresh failed:', e);
    }
  }

  // ========================================
  // WebRTC DataChannel interception
  // ========================================

  try {
  log('RTC: initializing DataChannel interception...');

  async function decompressIfGzipped(data: ArrayBuffer): Promise<Uint8Array> {
    const bytes = new Uint8Array(data);
    let gzipData: Uint8Array | null = null;

    if (bytes.length >= 3 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08) {
      gzipData = bytes;
    } else if (bytes.length >= 6 && bytes[3] === 0x1f && bytes[4] === 0x8b && bytes[5] === 0x08) {
      gzipData = bytes.slice(3);
    }

    if (!gzipData) return bytes;

    try {
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();

      writer.write(gzipData as unknown as BufferSource).catch(() => {});
      writer.close().catch(() => {});

      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }

      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    } catch {
      return bytes;
    }
  }

  const captionQueue = new Map<string, RtcCaptionMessage>();

  function flushCaptionQueue(): void {
    if (captionQueue.size === 0) return;
    const captions = Array.from(captionQueue.values());
    captionQueue.clear();

    debug('RTC: flushing caption queue', captions.length, 'messages');
    postToContentScript({
      type: MSG.RTC_CAPTION_DATA,
      captions,
      timestamp: Date.now(),
    });
  }

  setInterval(flushCaptionQueue, RTC_CAPTION_BATCH_MS);

  // Flush immediately when tab regains focus (timers are throttled in background)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) flushCaptionQueue();
  });

  function handleCaptionsMessage(data: Uint8Array): void {
    const caption = parseCaptionMessage(data);
    if (!caption || !caption.text) return;

    checkCaptionLanguage(caption);

    const existing = captionQueue.get(caption.messageId);
    if (!existing || existing.messageVersion <= caption.messageVersion) {
      captionQueue.set(caption.messageId, caption);
    }
  }

  function handleCollectionsMessage(data: Uint8Array): void {
    const device = parseDeviceInfo(data);
    if (device) {
      debug('RTC: device info (single)', device.deviceId, '→', device.deviceName);
      postToContentScript({
        type: MSG.RTC_DEVICE_INFO,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
      });
    }

    // Always also try collection parse — it may find additional devices
    const devices = parseDeviceCollection(data);
    const seenIds = new Set(device ? [device.deviceId] : []);
    for (const d of devices) {
      if (seenIds.has(d.deviceId)) continue;
      seenIds.add(d.deviceId);
      debug('RTC: device info (collection)', d.deviceId, '→', d.deviceName);
      postToContentScript({
        type: MSG.RTC_DEVICE_INFO,
        deviceId: d.deviceId,
        deviceName: d.deviceName,
      });
    }

    if (!device && devices.length === 0) {
      const strings = dumpAllStrings(data);
      if (strings.length > 0) {
        debug('RTC: collections message — no device info matched. All strings:', strings);
      }
    }

    const chat = parseChatMessage(data);
    if (chat && chat.text) {
      debug('RTC: chat from collections', chat.deviceId, chat.text.substring(0, 50));
      postToContentScript({
        type: MSG.RTC_CHAT_MESSAGE,
        deviceId: chat.deviceId,
        messageId: chat.messageId,
        text: chat.text,
        timestamp: Date.now(),
      });
    }
  }

  function handleChatMessage(data: Uint8Array): void {
    const chat = parseChatMessage(data);
    if (!chat || !chat.text) return;

    debug('RTC: chat message', chat.deviceId, chat.text.substring(0, 50));
    postToContentScript({
      type: MSG.RTC_CHAT_MESSAGE,
      deviceId: chat.deviceId,
      messageId: chat.messageId,
      text: chat.text,
      timestamp: Date.now(),
    });
  }

  let meetPeerConnection: RTCPeerConnection | null = null;
  let channelIdCounter = 50000;
  let origCreateDataChannel: (label: string, init?: RTCDataChannelInit) => RTCDataChannel;

  const channelMessageCounts = new Map<string, number>();
  // Track active channels per label so we can detect dead ones and avoid duplicates
  const activeChannels = new Map<string, RTCDataChannel>();

  function isChannelAlive(label: string): boolean {
    const ch = activeChannels.get(label);
    return !!ch && (ch.readyState === 'open' || ch.readyState === 'connecting');
  }

  function trackChannel(label: string, channel: RTCDataChannel): void {
    activeChannels.set(label, channel);
    const cleanup = () => { if (activeChannels.get(label) === channel) activeChannels.delete(label); };
    channel.addEventListener('close', cleanup);
    channel.addEventListener('error', cleanup);
  }

  function listenToChannel(channel: RTCDataChannel): void {
    const label = channel.label;
    debug(`RTC: listenToChannel("${label}") readyState=${channel.readyState} id=${channel.id}`);
    trackChannel(label, channel);

    channel.addEventListener('open', () => {
      debug(`RTC: channel "${label}" opened (id=${channel.id})`);
    });
    channel.addEventListener('close', () => {
      debug(`RTC: channel "${label}" closed (id=${channel.id})`);
    });
    channel.addEventListener('error', (e) => {
      debug(`RTC: channel "${label}" error (id=${channel.id})`, e);
    });

    channel.addEventListener('message', async (event: MessageEvent) => {
      // Only process messages from the currently-active channel for this label
      // to prevent duplicates when multiple channels share the same label.
      if (activeChannels.get(label) !== channel) return;

      const count = (channelMessageCounts.get(label) ?? 0) + 1;
      channelMessageCounts.set(label, count);
      if (label !== 'captions' || count <= 3) {
        debug(`RTC: message on "${label}" #${count}, type=${typeof event.data}, ` +
          `isArrayBuffer=${event.data instanceof ArrayBuffer}, isBlob=${event.data instanceof Blob}, ` +
          `size=${event.data?.byteLength ?? event.data?.size ?? event.data?.length ?? '?'}`);
      }

      try {
        let raw: ArrayBuffer;
        if (event.data instanceof ArrayBuffer) {
          raw = event.data;
        } else if (event.data instanceof Blob) {
          raw = await event.data.arrayBuffer();
        } else {
          debug(`RTC: channel "${label}" got non-binary data:`, typeof event.data, String(event.data).substring(0, 200));
          return;
        }

        const decompressed = await decompressIfGzipped(raw);

        switch (label) {
          case 'captions':
            handleCaptionsMessage(decompressed);
            break;
          case 'collections':
            handleCollectionsMessage(decompressed);
            break;
          case 'meet_messages':
            handleChatMessage(decompressed);
            break;
        }
      } catch (e) {
        debug('RTC: channel message error', label, e);
      }
    });
  }

  function openChannel(pc: RTCPeerConnection, label: string): void {
    // Don't create a duplicate if a healthy channel already exists
    if (isChannelAlive(label)) return;

    try {
      const channel = origCreateDataChannel.call(pc, label, {
        ordered: true,
        maxRetransmits: 10,
        id: ++channelIdCounter,
      });

      debug(`RTC: opened ${label} channel (id=${channelIdCounter})`);
      listenToChannel(channel);

      channel.addEventListener('close', () => {
        debug(`RTC: ${label} channel closed, will retry`);
        // Retry after a delay — the PC might be temporarily disconnected
        setTimeout(() => {
          if (meetPeerConnection === pc) openChannel(pc, label);
        }, 2000);
      });
    } catch (e) {
      debug(`RTC: failed to open ${label} channel`, e);
      // Retry after delay — the PC may recover
      setTimeout(() => {
        if (meetPeerConnection === pc) openChannel(pc, label);
      }, 5000);
    }
  }

  function ensureChannels(pc: RTCPeerConnection): void {
    meetPeerConnection = pc;
    openChannel(pc, 'captions');
    openChannel(pc, 'meet_messages');
    // Note: 'collections' channel is created by Meet itself as incoming — don't open manually
  }

  function handleIncomingChannel(pc: RTCPeerConnection, channel: RTCDataChannel): void {
    const label = channel.label;
    if (label === 'media-session') watchMediaSession(channel);
    if (!(RTC_CHANNEL_NAMES as readonly string[]).includes(label)) return;
    debug(`RTC: incoming datachannel "${label}"`);
    listenToChannel(channel);
    ensureChannels(pc);
  }

  // Intercept DataChannel.send() to capture outgoing messages (e.g. language changes)
  RTCDataChannel.prototype.send = function (data: string | ArrayBuffer | Blob | ArrayBufferView) {
    const label = this.label;
    try {
      let bytes: Uint8Array | null = null;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (data instanceof Uint8Array) bytes = data;
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

      // Meet's own sends on media-session: the channel, in case its creation
      // was missed, and what Meet says the caption language is.
      if (label === 'media-session') {
        if (this.readyState === 'open') watchMediaSession(this);
        if (bytes) noteMeetCaptionConfig(bytes);
      }

      if (bytes) {
        const hex = Array.from(bytes.slice(0, 80), b => b.toString(16).padStart(2, '0')).join(' ');
        debug(`RTC SEND "${label}" (${bytes.length} bytes): ${hex}`);
      } else {
        debug(`RTC SEND "${label}" (non-binary):`, typeof data, String(data).substring(0, 200));
      }
    } catch { /* silent */ }
    return origDCSend.call(this, data);
  };

  function patchCreateDataChannel(OrigProto: RTCPeerConnection): void {
    OrigProto.createDataChannel = function (
      label: string,
      dataChannelDict?: RTCDataChannelInit,
    ): RTCDataChannel {
      const channel = origCreateDataChannel.call(this, label, dataChannelDict);
      if (label === 'media-session') watchMediaSession(channel);
      if ((RTC_CHANNEL_NAMES as readonly string[]).includes(label)) {
        debug(`RTC: createDataChannel("${label}")`);
        listenToChannel(channel);
      }
      return channel;
    };
  }

  if (typeof RTCPeerConnection !== 'undefined') {
    const OriginalRTC = window.RTCPeerConnection;
    origCreateDataChannel = OriginalRTC.prototype.createDataChannel;
    patchCreateDataChannel(OriginalRTC.prototype as unknown as RTCPeerConnection);

    function InterceptedRTCPeerConnection(
      this: RTCPeerConnection,
      config?: RTCConfiguration,
    ): RTCPeerConnection {
      const connection = new OriginalRTC(config);
      debug('RTC: new RTCPeerConnection created');
      connection.addEventListener('datachannel', (event: RTCDataChannelEvent) => {
        handleIncomingChannel(connection, event.channel);
      });
      const tryOpenChannels = () => {
        const state = connection.connectionState ?? connection.iceConnectionState;
        if (state === 'connected') {
          // ensureChannels is safe to call repeatedly — it skips healthy channels
          log('RTC: peer connection ready, ensuring channels');
          ensureChannels(connection);
        } else if (state === 'failed' || state === 'closed') {
          debug('RTC: peer connection', state);
        }
      };
      connection.addEventListener('connectionstatechange', tryOpenChannels);
      connection.addEventListener('iceconnectionstatechange', tryOpenChannels);
      return connection;
    }

    InterceptedRTCPeerConnection.prototype = OriginalRTC.prototype;
    Object.setPrototypeOf(InterceptedRTCPeerConnection, OriginalRTC);
    (window as unknown as Record<string, unknown>).RTCPeerConnection =
      InterceptedRTCPeerConnection as unknown as typeof RTCPeerConnection;

    log('RTC DataChannel interception installed');
  }

  } catch (rtcError) {
    log('RTC: FAILED to initialize DataChannel interception:', rtcError);
  }

  log('Interceptor installed — monitoring RTC DataChannels');
  postToContentScript({ type: MSG.INTERCEPTOR_READY });
})();
