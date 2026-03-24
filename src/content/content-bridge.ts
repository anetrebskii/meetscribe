import { MESSAGE_SOURCE, KEEPALIVE_INTERVAL_MS } from '../utils/constants';
import { MSG, KEEPALIVE_PORT_NAME } from '../utils/types';

(function () {
  // Unique ID for this page load — allows the service worker to track
  // multiple simultaneous meetings (one per tab) independently.
  const sessionId = crypto.randomUUID();

  let port: chrome.runtime.Port | null = null;
  let contextInvalidated = false;

  function isContextInvalidated(): boolean {
    if (contextInvalidated) return true;
    try {
      void chrome.runtime.id;
      return false;
    } catch {
      contextInvalidated = true;
      return true;
    }
  }

  function connectKeepalive(): void {
    if (isContextInvalidated()) return;
    try {
      port = chrome.runtime.connect(undefined, { name: `${KEEPALIVE_PORT_NAME}:${sessionId}` });
      port.onDisconnect.addListener(() => {
        port = null;
        if (!isContextInvalidated()) {
          setTimeout(connectKeepalive, 1000);
        }
      });
    } catch {
      if (!isContextInvalidated()) {
        setTimeout(connectKeepalive, 5000);
      }
    }
  }

  setInterval(() => {
    if (isContextInvalidated()) return;
    if (port) {
      try {
        port.postMessage({ type: 'ping' });
      } catch {
        port = null;
        if (!isContextInvalidated()) connectKeepalive();
      }
    }
  }, KEEPALIVE_INTERVAL_MS);

  connectKeepalive();

  // Reconnect immediately when tab regains focus (timers throttled in background)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !port && !isContextInvalidated()) {
      connectKeepalive();
    }
  });

  // Expose sessionId so other content scripts in this tab (floating-popup) can read it
  document.documentElement.dataset.meetscribeSession = sessionId;

  // MAIN world → service worker relay
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== MESSAGE_SOURCE) return;

    const { source: _source, ...data } = event.data;

    if (
      data.type === MSG.RTC_CAPTION_DATA ||
      data.type === MSG.RTC_DEVICE_INFO ||
      data.type === MSG.RTC_CHAT_MESSAGE ||
      data.type === MSG.INTERCEPTOR_READY ||
      data.type === MSG.MEETING_CODE
    ) {
      if (isContextInvalidated()) return;
      try {
        chrome.runtime.sendMessage({ ...data, sessionId }).catch(() => {});
      } catch { /* extension context invalidated */ }
    }
  });

  // Service worker → MAIN world relay (for language changes and device refresh)
  chrome.runtime.onMessage.addListener((message): undefined => {
    if (message.type === MSG.LANGUAGE_CHANGE) {
      window.postMessage({
        source: MESSAGE_SOURCE,
        type: MSG.LANGUAGE_CHANGE,
        language: message.language,
      }, '*');
    } else if (message.type === MSG.REFRESH_DEVICES) {
      window.postMessage({
        source: MESSAGE_SOURCE,
        type: MSG.REFRESH_DEVICES,
      }, '*');
    } else if (message.type === MSG.RETRY_CAPTIONS) {
      // Handled by caption-observer directly (same ISOLATED world)
    }
  });
})();
