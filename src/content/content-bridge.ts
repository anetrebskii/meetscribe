import { MESSAGE_SOURCE, KEEPALIVE_INTERVAL_MS } from '../utils/constants';
import { MSG, KEEPALIVE_PORT_NAME } from '../utils/types';

(function () {
  let port: chrome.runtime.Port | null = null;

  function connectKeepalive(): void {
    try {
      port = chrome.runtime.connect(undefined, { name: KEEPALIVE_PORT_NAME });
      port.onDisconnect.addListener(() => {
        port = null;
        setTimeout(connectKeepalive, 1000);
      });
    } catch {
      setTimeout(connectKeepalive, 5000);
    }
  }

  setInterval(() => {
    if (port) {
      try {
        port.postMessage({ type: 'ping' });
      } catch {
        port = null;
        connectKeepalive();
      }
    }
  }, KEEPALIVE_INTERVAL_MS);

  connectKeepalive();

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
      try {
        chrome.runtime.sendMessage(data).catch(() => {});
      } catch { /* extension context invalidated */ }
    }
  });

  // Service worker → MAIN world relay (for language changes)
  chrome.runtime.onMessage.addListener((message): undefined => {
    if (message.type === MSG.LANGUAGE_CHANGE) {
      window.postMessage({
        source: MESSAGE_SOURCE,
        type: MSG.LANGUAGE_CHANGE,
        language: message.language,
      }, '*');
    }
  });
})();
