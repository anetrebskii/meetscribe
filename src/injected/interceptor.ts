import { MESSAGE_SOURCE, RTC_CHANNEL_NAMES, RTC_CAPTION_BATCH_MS } from '../utils/constants';
import { parseCaptionMessage, parseDeviceInfo, parseDeviceCollection, parseChatMessage, dumpAllStrings } from '../utils/rtc-message-parser';
import { encodeUpdateMediaSession } from '../utils/protobuf-encoder';
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

  const meetingCode = extractMeetingCode();
  if (meetingCode) {
    // Post immediately and also after a short delay (in case content script isn't ready yet)
    postToContentScript({ type: MSG.MEETING_CODE, meetingCode });
    setTimeout(() => postToContentScript({ type: MSG.MEETING_CODE, meetingCode }), 1000);
  }

  // ========================================
  // Language change API via UpdateMediaSession
  // ========================================

  let capturedSessionId: string | null = null;
  let capturedHeaders: Record<string, string> = {};

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
        }

        // Try to extract session ID from request body
        if (init?.body) {
          try {
            let raw: Uint8Array | null = null;
            if (init.body instanceof ArrayBuffer) raw = new Uint8Array(init.body);
            else if (init.body instanceof Uint8Array) raw = init.body;
            else if (typeof init.body === 'string') raw = new TextEncoder().encode(init.body);

            if (raw) {
              // Look for session ID in text representation
              const bodyStr = new TextDecoder().decode(raw);
              const sessionMatch = bodyStr.match(/\b[A-Za-z0-9_-]{28}\b/);
              if (sessionMatch) capturedSessionId = capturedSessionId || sessionMatch[0];

}
          } catch { /* not text / decode error */ }
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

  // Listen for language change requests from content script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== MESSAGE_SOURCE) return;
    if (event.data.type !== MSG.LANGUAGE_CHANGE) return;

    const langCode = event.data.language as string;
    debug('Language change requested:', langCode);
    changeCaptionLanguage(langCode);
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

  async function changeCaptionLanguage(langCode: string): Promise<void> {
    if (!capturedSessionId || !capturedHeaders['authorization']) {
      debug('Cannot change language: no captured session/headers');
      return;
    }

    try {
      const body = encodeUpdateMediaSession(capturedSessionId, langCode);
      const url = `https://meet.google.com/$rpc/google.rtc.meetings.v1.MediaSessionService/UpdateMediaSession`;
      const resp = await originalFetch.call(window, url, {
        method: 'POST',
        headers: capturedHeaders,
        body: body.buffer as ArrayBuffer,
      });
      if (!resp.ok) {
        debug('Language change failed:', resp.status, resp.statusText);
      } else {
        persistLanguageCode(langCode);
        debug('Language change API call sent for', langCode);
      }
    } catch (e) {
      debug('Language change API call failed:', e);
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
    if (!(RTC_CHANNEL_NAMES as readonly string[]).includes(label)) return;
    debug(`RTC: incoming datachannel "${label}"`);
    listenToChannel(channel);
    ensureChannels(pc);
  }

  function patchCreateDataChannel(OrigProto: RTCPeerConnection): void {
    OrigProto.createDataChannel = function (
      label: string,
      dataChannelDict?: RTCDataChannelInit,
    ): RTCDataChannel {
      const channel = origCreateDataChannel.call(this, label, dataChannelDict);
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
