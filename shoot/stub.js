/**
 * The `chrome.*` the panel and the popup expect, answered out of a fixture
 * instead of a service worker. Injected into every frame before its own
 * scripts run, so the real bundles boot unchanged.
 *
 * `window.__deliver` pushes a port message in, the way the worker would;
 * `window.__runtime` pushes a `chrome.runtime.onMessage` one.
 */
module.exports = function install(fix) {
  const ports = [];
  const onMessage = [];

  function makePort(name) {
    const listeners = [];
    const port = {
      name,
      postMessage(message) { (window.__sent = window.__sent || []).push(message); },
      disconnect() {},
      onMessage: { addListener: (fn) => listeners.push(fn), removeListener() {} },
      onDisconnect: { addListener() {}, removeListener() {} },
      deliver(message) { for (const fn of listeners.slice()) fn(message, port); },
    };
    ports.push(port);
    return port;
  }

  window.__deliver = (message) => { for (const port of ports.slice()) port.deliver(message); };
  window.__runtime = (message) => { for (const fn of onMessage.slice()) fn(message, {}, () => {}); };

  const withoutEntries = (m) => {
    const copy = Object.assign({}, m);
    delete copy.entries;
    return copy;
  };

  function answer(message) {
    const type = message && message.type;
    if (type === 'get_meetings') {
      return { meetings: fix.meetings.map(withoutEntries), liveMeetingIds: fix.live || [] };
    }
    if (type === 'get_meeting_entries') {
      const found = fix.meetings.find((m) => m.id === (message.meetingId || (message.payload || {}).id));
      return { entries: found ? found.entries : [], notes: [] };
    }
    if (type === 'delete_meeting') return fix.deleteAnswer || { ok: true };
    if (type === 'get_meeting_titles') return { titles: {} };
    if (type === 'get_settings') return { settings: { enabled: true, language: fix.language || 'en' } };
    if (type === 'get_current_meeting') return { meeting: null };
    if (type === 'export_meeting') return { content: '' };
    return {};
  }

  window.chrome = {
    runtime: {
      id: 'shoot',
      connect: (_extension, info) => makePort((info && info.name) || 'port'),
      sendMessage: (message) => Promise.resolve(answer(message)),
      onMessage: { addListener: (fn) => onMessage.push(fn), removeListener() {} },
      getURL: (path) => path,
    },
    storage: {
      local: {
        get(keys) {
          const store = fix.storage || {};
          const wanted = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || store);
          const out = {};
          for (const key of wanted) if (store[key] !== undefined) out[key] = store[key];
          return Promise.resolve(out);
        },
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
    },
    tabs: {
      create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      query: () => Promise.resolve([]),
    },
  };
};
