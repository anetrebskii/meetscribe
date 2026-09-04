import { MSG, POPUP_PORT_NAME, type TranscriptEntry, type NoteEntry, type Meeting } from '../utils/types';
import { LANGUAGE_CODES } from '../utils/constants';
import { exportAsMarkdown } from '../utils/transcript-store';
import type { Snapshot as NotulaSnapshot, PairStage } from '../background/notula-sync';
import {
  AWAITING_POLL_MS,
  LINK_ICON,
  NOTULA_SITE,
  brainLink,
  connected,
  destinationFor,
  renderConnect,
  renderOffers,
  renderScreen as renderNotulaScreen,
  saveLine,
  stageAfter,
  liveLine,
} from '../utils/notula-ui';
import type { NotulaContext, UiStage } from '../utils/notula-ui';

(function () {
  const STORAGE_POS_KEY = 'popup_position';
  const STORAGE_SIZE_KEY = 'popup_size';
  const DEFAULT_WIDTH = 350;
  const DEFAULT_HEIGHT = 400;
  const MIN_WIDTH = 280;
  const MIN_HEIGHT = 200;

  let port: chrome.runtime.Port | null = null;
  let entries: TranscriptEntry[] = [];
  let notes: NoteEntry[] = [];
  let currentMeeting: Meeting | null = null;
  let participantCount = 0;
  let isMinimized = false;
  let isHidden = true; // Start hidden, auto-show when in a real meeting
  let contextInvalidated = false;

  /** Detect if the extension context has been invalidated (extension updated/reloaded). */
  function isContextInvalidated(): boolean {
    if (contextInvalidated) return true;
    try {
      // Accessing chrome.runtime.id throws if context is invalidated
      void chrome.runtime.id;
      return false;
    } catch {
      contextInvalidated = true;
      return true;
    }
  }

  /** Show a banner in the popup telling the user to refresh. */
  function showRefreshBanner(): void {
    const existing = container?.querySelector('.refresh-banner');
    if (existing) return;
    const banner = document.createElement('div');
    banner.className = 'refresh-banner';
    banner.textContent = 'Extension updated — refresh the page to resume transcription';
    banner.style.cssText = 'background:#b71c1c;color:#fff;padding:8px 12px;font-size:12px;text-align:center;cursor:pointer;';
    banner.addEventListener('click', () => location.reload());
    container?.prepend(banner);
  }


  let isDragging = false;
  let isResizing = false;
  let resizeEdge = '';
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartW = 0;
  let resizeStartH = 0;
  let resizeStartLeft = 0;
  let resizeStartTop = 0;
  let autoScroll = true;
  let currentView: 'live' | 'meetings' | 'meeting-detail' = 'live';
  let viewingMeetingId: string | null = null;
  let detailEntries: TranscriptEntry[] = [];
  let detailNotes: NoteEntry[] = [];
  let detailTitle = '';
  let detailStartTime = 0;
  let popupWidth = DEFAULT_WIDTH;
  let popupHeight = DEFAULT_HEIGHT;

  // --- Notula: what the service worker last said, and which screen is up ---

  let notulaSnapshot: NotulaSnapshot | null = null;
  let pairStage: UiStage = 'idle';
  let pairCode = '';
  let awaitingTimer: ReturnType<typeof setInterval> | null = null;
  let captionsMissing = false;
  let screenShown = false;
  let footerWhereKey = '';

  // --- Shadow DOM setup ---

  const host = document.createElement('div');
  host.id = '__meet-transcription-popup';
  host.style.cssText = 'all: initial; position: fixed; z-index: 999999; display: none;';
  const shadow = host.attachShadow({ mode: 'closed' });

  const styleEl = document.createElement('style');
  shadow.appendChild(styleEl);

  const container = document.createElement('div');
  container.className = 'popup';
  shadow.appendChild(container);

  // --- Build UI ---

  container.innerHTML = `
    <div class="header" id="header">
      <div class="drag-handle" id="drag-handle">
        <span class="title"><span class="title-prefix">Notula</span> <span class="title-sep">–</span> <span class="title-page" id="popup-title">Live</span></span>
      </div>
      <div class="header-actions">
        <button class="btn-icon" id="btn-meetings" title="Meetings">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
        </button>
        <button class="btn-icon" id="btn-minimize" title="Minimize">&#8211;</button>
        <button class="btn-icon" id="btn-close" title="Close">&#215;</button>
      </div>
    </div>
    <button class="connect" id="connect-offer" hidden>${LINK_ICON}<span>Save to your Git repo via Notula</span></button>
    <div class="connect warning" id="connect-wait" hidden>Waiting for Notula</div>
    <div class="body" id="body">
      <div class="toolbar" id="toolbar">
        <select class="lang-select" id="lang-select"></select>
        <button class="toolbar-action" id="btn-copy" title="Copy as Markdown"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        <button class="toolbar-action" id="btn-export" title="Export transcript"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
      </div>
      <div class="back-nav" id="back-nav">
        <button class="btn-back-live" id="btn-back-live">&larr; Meetings</button>
      </div>
      <div class="content-area" id="content-area">
        <div class="offers" id="offers"></div>
        <div class="screen" id="screen" hidden></div>
        <div class="live-sections" id="live-sections">
          <div class="section" id="section-notes">
            <div class="section-header" id="section-notes-header">
              <span class="section-title">Notes</span>
              <span class="section-chevron">&#9660;</span>
            </div>
            <div class="section-body" id="section-notes-body">
              <div class="notes-input-row">
                <input type="text" class="notes-input" id="notes-input" placeholder="Add a note…" />
                <button class="btn-small btn-add-note" id="btn-add-note">Add</button>
              </div>
              <div class="notes-list" id="notes-list"></div>
            </div>
          </div>
          <div class="section" id="section-transcript">
            <div class="section-header" id="section-transcript-header">
              <span class="section-title">Transcription</span>
              <span class="section-chevron">&#9660;</span>
            </div>
            <div class="section-body" id="section-transcript-body">
              <div class="placeholder" id="transcript-placeholder" hidden>Listening…</div>
              <div class="transcript" id="transcript"></div>
            </div>
          </div>
        </div>
        <div class="meetings-view" id="meetings-view" style="display:none"></div>
        <div class="detail-view" id="detail-view" style="display:none"></div>
      </div>
      <div class="footer" id="footer">
        <span id="footer-left">0 lines</span>
        <span id="footer-right"></span>
      </div>
    </div>
    <div class="edge edge-n" data-edge="n"></div>
    <div class="edge edge-s" data-edge="s"></div>
    <div class="edge edge-w" data-edge="w"></div>
    <div class="edge edge-e" data-edge="e"></div>
    <div class="edge edge-nw" data-edge="nw"></div>
    <div class="edge edge-ne" data-edge="ne"></div>
    <div class="edge edge-sw" data-edge="sw"></div>
    <div class="edge edge-se" data-edge="se"></div>
  `;

  // --- Element references ---

  const dragHandle = shadow.getElementById('drag-handle')!;
  const popupTitle = shadow.getElementById('popup-title')!;
  const bodyEl = shadow.getElementById('body')!;
  const transcriptEl = shadow.getElementById('transcript')!;
  const meetingsEl = shadow.getElementById('meetings-view')!;
  const detailEl = shadow.getElementById('detail-view')!;
  const footerLeft = shadow.getElementById('footer-left')!;
  const footerRight = shadow.getElementById('footer-right')!;
  const langSelect = shadow.getElementById('lang-select') as HTMLSelectElement;
  const btnMinimize = shadow.getElementById('btn-minimize')!;
  const btnClose = shadow.getElementById('btn-close')!;
  const btnMeetings = shadow.getElementById('btn-meetings')!;
  const btnCopy = shadow.getElementById('btn-copy')!;
  const btnExport = shadow.getElementById('btn-export')!;
  const edgeHandles = shadow.querySelectorAll<HTMLElement>('.edge');
  const toolbarEl = shadow.getElementById('toolbar')!;
  const footerEl = shadow.getElementById('footer')!;
  const backNav = shadow.getElementById('back-nav')!;
  const btnBackLive = shadow.getElementById('btn-back-live')!;
  const liveSections = shadow.getElementById('live-sections')!;
  const sectionNotesHeader = shadow.getElementById('section-notes-header')!;
  const sectionNotesBody = shadow.getElementById('section-notes-body')!;
  const sectionTranscriptHeader = shadow.getElementById('section-transcript-header')!;
  const sectionTranscriptBody = shadow.getElementById('section-transcript-body')!;
  const notesInput = shadow.getElementById('notes-input') as HTMLInputElement;
  const btnAddNote = shadow.getElementById('btn-add-note')!;
  const notesList = shadow.getElementById('notes-list')!;
  const connectOffer = shadow.getElementById('connect-offer') as HTMLButtonElement;
  const connectWait = shadow.getElementById('connect-wait')!;
  const offersEl = shadow.getElementById('offers')!;
  const screenEl = shadow.getElementById('screen')!;
  const placeholderEl = shadow.getElementById('transcript-placeholder')!;

  const notulaCtx: NotulaContext = {
    snapshot: () => notulaSnapshot,
    send: (message) => sendNotula(message),
    container,
  };

  btnBackLive.addEventListener('click', () => {
    switchView('meetings');
  });

  // --- Collapsible sections ---

  function toggleSection(header: HTMLElement, body: HTMLElement): void {
    const collapsed = body.style.display === 'none';
    body.style.display = collapsed ? '' : 'none';
    header.querySelector('.section-chevron')!.textContent = collapsed ? '\u25BC' : '\u25B6';
    header.classList.toggle('collapsed', !collapsed);
  }

  sectionNotesHeader.addEventListener('click', () => toggleSection(sectionNotesHeader, sectionNotesBody));
  sectionTranscriptHeader.addEventListener('click', () => toggleSection(sectionTranscriptHeader, sectionTranscriptBody));

  function addNoteFromInput(): void {
    const text = notesInput.value.trim();
    if (!text || !currentMeeting) return;
    notesInput.value = '';
    chrome.runtime.sendMessage({
      type: MSG.ADD_NOTE,
      payload: { meetingId: currentMeeting.id, text },
    }).catch(() => {});
  }

  btnAddNote.addEventListener('click', addNoteFromInput);
  // Stop all keyboard events from reaching Google Meet's shortcut handler.
  // Composed events escape the shadow DOM, so we catch them on the host in
  // the capture phase. All input-specific logic (Enter to save) must live
  // here too, because stopPropagation in capture prevents bubble listeners.
  for (const evt of ['keydown', 'keyup', 'keypress'] as const) {
    host.addEventListener(evt, (e: Event) => {
      const active = shadow.activeElement as HTMLElement | null;
      if (!active) return;
      const isNotesInput = active === notesInput;
      const isEditable = active.contentEditable === 'true';
      if (!isNotesInput && !isEditable) return;
      e.stopPropagation();
      if (isNotesInput && evt === 'keydown' && (e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        addNoteFromInput();
      }
    }, true);
  }

  function renderNoteItem(note: NoteEntry): HTMLElement {
    const div = document.createElement('div');
    div.className = 'note-item';
    div.dataset.noteId = note.id;
    const time = new Date(note.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
      <span class="note-time">${time}</span>
      <div class="note-text">${escapeHtml(note.text)}</div>
      <button class="note-delete" title="Delete note">\u2715</button>
    `;
    const textEl = div.querySelector('.note-text') as HTMLElement;

    // Double-click to edit
    textEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      textEl.contentEditable = 'true';
      textEl.focus();
      const range = document.createRange();
      range.selectNodeContents(textEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    textEl.addEventListener('blur', () => {
      if (textEl.contentEditable !== 'true') return;
      textEl.contentEditable = 'false';
      const newText = textEl.textContent?.trim();
      if (newText && currentMeeting && newText !== note.text) {
        note.text = newText;
        chrome.runtime.sendMessage({
          type: MSG.UPDATE_NOTE,
          payload: { meetingId: currentMeeting.id, noteId: note.id, text: newText },
        }).catch(() => {});
      }
    });
    for (const evt of ['keydown', 'keyup', 'keypress'] as const) {
      textEl.addEventListener(evt, (e: Event) => { e.stopPropagation(); });
    }
    textEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); textEl.blur(); }
      if (e.key === 'Escape') { textEl.textContent = note.text; textEl.blur(); }
    });

    div.querySelector('.note-delete')!.addEventListener('click', () => {
      if (!currentMeeting) return;
      chrome.runtime.sendMessage({
        type: MSG.DELETE_NOTE,
        payload: { meetingId: currentMeeting.id, noteId: note.id },
      }).catch(() => {});
    });
    return div;
  }


  function renderAllNotes(): void {
    notesList.innerHTML = '';
    const sorted = [...notes].sort((a, b) => b.timestamp - a.timestamp);
    for (const note of sorted) {
      notesList.appendChild(renderNoteItem(note));
    }
  }

  // --- Language selector: build with recent languages at top ---

  let recentLanguages: string[] = [];

  async function buildLanguageSelector(): Promise<void> {
    // Load recent languages and last selected
    try {
      const stored = await chrome.storage.local.get(['recentLanguages', 'settings']);
      recentLanguages = stored.recentLanguages ?? [];
      const lastLang = stored.settings?.language ?? '';

      langSelect.innerHTML = '';

      // Default placeholder
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = 'Language';
      langSelect.appendChild(defaultOpt);

      const allLangs = Object.values(LANGUAGE_CODES);

      // Recent languages section
      if (recentLanguages.length > 0) {
        const recentGroup = document.createElement('optgroup');
        recentGroup.label = 'Recent';
        for (const code of recentLanguages) {
          const lang = allLangs.find(l => l.code === code);
          if (lang) {
            const opt = document.createElement('option');
            opt.value = lang.code;
            opt.textContent = lang.name;
            recentGroup.appendChild(opt);
          }
        }
        langSelect.appendChild(recentGroup);

        // All languages section
        const allGroup = document.createElement('optgroup');
        allGroup.label = 'All Languages';
        for (const { code, name } of allLangs) {
          const opt = document.createElement('option');
          opt.value = code;
          opt.textContent = name;
          allGroup.appendChild(opt);
        }
        langSelect.appendChild(allGroup);
      } else {
        // No recent — flat list
        for (const { code, name } of allLangs) {
          const opt = document.createElement('option');
          opt.value = code;
          opt.textContent = name;
          langSelect.appendChild(opt);
        }
      }

      // Restore last selected
      if (lastLang) {
        langSelect.value = lastLang;
      }
    } catch { /* silent */ }
  }

  buildLanguageSelector();

  // --- Live title rename (double-click) ---

  // --- Autocomplete helper ---

  let acList: HTMLElement | null = null;
  let acItems: string[] = [];
  let acIndex = -1;
  let acTarget: HTMLElement | null = null;

  function showAutocomplete(target: HTMLElement): void {
    removeAutocomplete();
    acTarget = target;
    acList = document.createElement('div');
    acList.className = 'autocomplete-list';
    // Position below the target
    const rect = target.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    acList.style.left = `${rect.left - containerRect.left}px`;
    acList.style.top = `${rect.bottom - containerRect.top + 2}px`;
    acList.style.minWidth = `${rect.width}px`;
    container.appendChild(acList);

    chrome.runtime.sendMessage({ type: MSG.GET_MEETING_TITLES }).then((res) => {
      acItems = (res?.titles ?? []) as string[];
      filterAutocomplete();
    }).catch(() => {});

    target.addEventListener('input', onAcInput);
  }

  function onAcInput(): void { acIndex = -1; filterAutocomplete(); }

  function filterAutocomplete(): void {
    if (!acList || !acTarget) return;
    const query = (acTarget.textContent ?? '').trim().toLowerCase();
    const matches = query
      ? acItems.filter(t => t.toLowerCase().includes(query) && t.toLowerCase() !== query)
      : acItems;
    acList.innerHTML = '';
    acIndex = -1;
    for (const title of matches.slice(0, 6)) {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.textContent = title;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // prevent blur
        if (acTarget) {
          acTarget.textContent = title;
          acTarget.blur();
        }
      });
      acList.appendChild(item);
    }
  }

  function navigateAutocomplete(dir: number): void {
    if (!acList) return;
    const items = acList.querySelectorAll('.autocomplete-item');
    if (items.length === 0) return;
    if (acIndex >= 0) items[acIndex].classList.remove('active');
    acIndex = (acIndex + dir + items.length) % items.length;
    items[acIndex].classList.add('active');
  }

  function acceptAutocomplete(): boolean {
    if (!acList || acIndex < 0) return false;
    const items = acList.querySelectorAll('.autocomplete-item');
    if (acIndex < items.length && acTarget) {
      acTarget.textContent = items[acIndex].textContent;
      return true;
    }
    return false;
  }

  function removeAutocomplete(): void {
    if (acList) { acList.remove(); acList = null; }
    if (acTarget) { acTarget.removeEventListener('input', onAcInput); }
    acTarget = null;
    acItems = [];
    acIndex = -1;
  }

  popupTitle.addEventListener('dblclick', (e) => {
    if (currentView !== 'live' || !currentMeeting) return;
    e.stopPropagation();
    popupTitle.contentEditable = 'true';
    popupTitle.focus();
    const range = document.createRange();
    range.selectNodeContents(popupTitle);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    showAutocomplete(popupTitle);
  });
  popupTitle.addEventListener('blur', () => {
    if (popupTitle.contentEditable !== 'true') return;
    popupTitle.contentEditable = 'false';
    removeAutocomplete();
    const newTitle = popupTitle.textContent?.trim();
    if (newTitle && currentMeeting && newTitle !== currentMeeting.title) {
      currentMeeting.title = newTitle;
      chrome.runtime.sendMessage({
        type: MSG.RENAME_MEETING,
        payload: { id: currentMeeting.id, title: newTitle },
      }).catch(() => {});
    }
  });
  popupTitle.addEventListener('keydown', (e: KeyboardEvent) => {
    if (popupTitle.contentEditable !== 'true') return;
    // Stop all keys from reaching Google Meet's shortcut handler (C=captions, D=camera, M=mic, etc.)
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); navigateAutocomplete(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); navigateAutocomplete(-1); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && acIndex >= 0)) {
      e.preventDefault();
      if (acceptAutocomplete()) { popupTitle.blur(); }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      popupTitle.blur();
    }
    if (e.key === 'Escape') {
      popupTitle.textContent = currentMeeting?.title ?? 'Live';
      popupTitle.blur();
    }
  });

  // --- Event handlers ---

  langSelect.addEventListener('change', () => {
    const lang = langSelect.value;
    if (lang) {
      chrome.runtime.sendMessage({ type: MSG.LANGUAGE_CHANGE, language: lang }).catch(() => {});
      // Rebuild selector after a short delay to update recent list
      setTimeout(buildLanguageSelector, 500);
    }
  });

  btnMinimize.addEventListener('click', () => {
    isMinimized = !isMinimized;
    bodyEl.style.display = isMinimized ? 'none' : '';
    edgeHandles.forEach(el => el.style.display = isMinimized ? 'none' : '');
    container.classList.toggle('minimized', isMinimized);
    btnMinimize.innerHTML = isMinimized ? '&#9744;' : '&#8211;';
    btnMinimize.title = isMinimized ? 'Expand' : 'Minimize';
  });

  btnClose.addEventListener('click', () => {
    isHidden = true;
    host.style.display = 'none';
  });

  btnMeetings.addEventListener('click', () => {
    if (currentView === 'meetings') {
      switchView('live');
    } else {
      switchView('meetings');
    }
  });

  async function copyToClipboard(text: string, feedbackEl: HTMLElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for contexts where clipboard API is blocked
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    const orig = feedbackEl.innerHTML;
    feedbackEl.textContent = '\u2713';
    feedbackEl.title = 'Copied!';
    setTimeout(() => {
      feedbackEl.innerHTML = orig;
      feedbackEl.title = 'Copy as Markdown';
    }, 1500);
  }

  async function getExportResponse(): Promise<{ content?: string; title?: string; startTime?: number } | undefined> {
    if (currentView === 'meeting-detail' && viewingMeetingId) {
      // Use locally cached entries — the service worker may have restarted
      // and lost in-memory data, so we format directly from the entries
      // that were already fetched and displayed.
      if (detailEntries.length > 0) {
        const content = exportAsMarkdown(detailEntries, detailTitle, detailNotes);
        return { content, title: detailTitle, startTime: detailStartTime };
      }
      return chrome.runtime.sendMessage({
        type: MSG.EXPORT_MEETING,
        payload: { id: viewingMeetingId, format: 'md' },
      });
    }
    const title = currentMeeting?.title ?? 'Meeting Transcript';
    return chrome.runtime.sendMessage({
      type: MSG.EXPORT_TRANSCRIPT,
      payload: { format: 'md', title },
    });
  }

  btnCopy.addEventListener('click', async () => {
    try {
      const response = await getExportResponse();
      if (response?.content) {
        await copyToClipboard(response.content, btnCopy);
      }
    } catch { /* silent */ }
  });

  function download(content: string, title: string, startTime: number): void {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = title.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
    const d = new Date(startTime);
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    a.download = `${safeName} ${dateStr}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  btnExport.addEventListener('click', async () => {
    try {
      const response = await getExportResponse();
      if (response?.content) {
        download(
          response.content,
          response.title ?? currentMeeting?.title ?? 'Meeting Transcript',
          response.startTime ?? currentMeeting?.startTime ?? Date.now(),
        );
      }
    } catch { /* silent */ }
  });

  // --- View switching ---

  function applyViewDisplays(): void {
    const view = currentView;
    liveSections.style.display = view === 'live' ? '' : 'none';
    meetingsEl.style.display = view === 'meetings' ? '' : 'none';
    detailEl.style.display = view === 'meeting-detail' ? '' : 'none';
    toolbarEl.style.display = (view === 'live' || view === 'meeting-detail') ? '' : 'none';
    langSelect.style.display = view === 'live' ? '' : 'none';
    backNav.style.display = (view === 'live' || view === 'meeting-detail') ? '' : 'none';
    footerEl.style.display = '';
    offersEl.style.display = view === 'meeting-detail' ? 'none' : '';
  }

  function switchView(view: typeof currentView): void {
    currentView = view;
    applyViewDisplays();

    btnMeetings.classList.toggle('active', view === 'meetings' || view === 'meeting-detail');

    switch (view) {
      case 'live':
        popupTitle.textContent = currentMeeting ? currentMeeting.title : 'Live';
        renderAllEntries();
        break;
      case 'meetings':
        popupTitle.textContent = 'Meetings';
        footerLeft.innerHTML = brainLink();
        footerRight.textContent = '';
        loadMeetingsList();
        break;
      case 'meeting-detail':
        // title set by loadMeetingDetail
        break;
    }
    renderOffers(notulaCtx, offersEl);
    renderScreen();
  }

  // --- Toggle popup visibility (from toolbar icon) ---

  chrome.runtime.onMessage.addListener((message): undefined => {
    // The language the service worker pushed for this call, so the selector says what Meet was told.
    if (message.type === MSG.LANGUAGE_CHANGE && typeof message.language === 'string') {
      langSelect.value = message.language;
      return undefined;
    }
    if (message.type === MSG.TOGGLE_POPUP) {
      isHidden = !isHidden;
      host.style.display = isHidden ? 'none' : '';
      if (!isHidden && !port) {
        connectPort();
      }
      // The panel was opened: one of the three occasions Notula is asked after.
      if (!isHidden) sendNotula({ type: 'notula_check' });
    }
  });

  // --- Dragging ---

  dragHandle.addEventListener('mousedown', (e: MouseEvent) => {
    isDragging = true;
    const rect = host.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (isDragging) {
      const x = Math.max(0, Math.min(window.innerWidth - 50, e.clientX - dragOffsetX));
      const y = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - dragOffsetY));
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    }
    if (isResizing) {
      const dx = e.clientX - resizeStartX;
      const dy = e.clientY - resizeStartY;
      if (resizeEdge.includes('e')) {
        popupWidth = Math.max(MIN_WIDTH, resizeStartW + dx);
      }
      if (resizeEdge.includes('s')) {
        popupHeight = Math.max(MIN_HEIGHT, resizeStartH + dy);
      }
      if (resizeEdge.includes('w')) {
        const newW = Math.max(MIN_WIDTH, resizeStartW - dx);
        host.style.left = `${resizeStartLeft + (resizeStartW - newW)}px`;
        host.style.right = 'auto';
        popupWidth = newW;
      }
      if (resizeEdge.includes('n')) {
        const newH = Math.max(MIN_HEIGHT, resizeStartH - dy);
        host.style.top = `${resizeStartTop + (resizeStartH - newH)}px`;
        host.style.bottom = 'auto';
        popupHeight = newH;
      }
      applySize();
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      savePosition();
    }
    if (isResizing) {
      isResizing = false;
      saveSize();
      savePosition();
    }
  });

  // --- Resizing ---

  edgeHandles.forEach(el => {
    el.addEventListener('mousedown', (e: MouseEvent) => {
      isResizing = true;
      resizeEdge = el.dataset.edge ?? '';
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      resizeStartW = popupWidth;
      resizeStartH = popupHeight;
      const rect = host.getBoundingClientRect();
      resizeStartLeft = rect.left;
      resizeStartTop = rect.top;
      e.preventDefault();
      e.stopPropagation();
    });
  });

  function applySize(): void {
    container.style.width = `${popupWidth}px`;
    container.style.height = `${popupHeight}px`;
  }

  // --- Auto-scroll ---

  transcriptEl.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = transcriptEl;
    autoScroll = scrollHeight - scrollTop - clientHeight < 50;
  });

  // --- Rendering ---

  function countParticipants(m: Meeting | Omit<Meeting, 'entries'>): number {
    const names = Object.values(m.participants || {});
    return new Set(names.filter(p => p !== m.meetingCode && !p.startsWith('@'))).size;
  }

  function escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderEntry(entry: TranscriptEntry): HTMLElement {
    const div = document.createElement('div');
    div.className = 'entry';
    div.dataset.id = entry.id;
    const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
      <span class="speaker">${escapeHtml(entry.speaker)}</span>
      <span class="time">${time}</span>
      <div class="text">${escapeHtml(entry.text)}</div>
    `;
    return div;
  }

  function renderPlaceholder(): void {
    const empty = entries.length === 0 && currentMeeting !== null;
    placeholderEl.hidden = !empty;
    placeholderEl.textContent = captionsMissing
      ? 'Turn on captions in Meet - that is what the transcript reads.'
      : 'Listening…';
  }

  function appendEntry(entry: TranscriptEntry): void {
    // Only append if viewing live
    if (currentView !== 'live') return;
    captionsMissing = false;
    renderPlaceholder();
    transcriptEl.appendChild(renderEntry(entry));
    updateFooter();
    if (autoScroll) {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }
  }

  function updateEntryInPlace(entry: TranscriptEntry): void {
    if (currentView !== 'live') return;
    const existing = transcriptEl.querySelector(`[data-id="${entry.id}"]`);
    if (existing) {
      const textEl = existing.querySelector('.text');
      if (textEl) textEl.textContent = entry.text;
      const speakerEl = existing.querySelector('.speaker');
      if (speakerEl) speakerEl.textContent = entry.speaker;
      if (autoScroll) {
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
      }
    }
  }

  function renderAllEntries(): void {
    transcriptEl.innerHTML = '';
    for (const entry of entries) {
      transcriptEl.appendChild(renderEntry(entry));
    }
    renderPlaceholder();
    updateFooter();
    if (autoScroll) {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }
  }

  function updateFooter(): void {
    if (currentView !== 'live' && currentView !== 'meeting-detail') return;
    const lines = currentView === 'live' ? entries.length : detailEntries.length;
    const noteCount = currentView === 'live' ? notes.length : detailNotes.length;
    footerLeft.textContent = `${lines} line${lines === 1 ? '' : 's'}${noteCount > 0 ? ` \u00b7 ${noteCount} note${noteCount === 1 ? '' : 's'}` : ''}`;

    const meeting = currentView === 'live' ? currentMeeting : null;
    // Where this call will land, said before the file exists rather than after.
    if (meeting && connected(notulaCtx)) {
      const dest = destinationFor(notulaSnapshot, meeting.meetingCode);
      const save = notulaSnapshot?.saves[meeting.id];
      const key = `${meeting.id}:${dest?.workspace ?? ''}:${dest?.folder ?? ''}:${save?.state ?? ''}:${save?.path ?? ''}`;
      if (footerWhereKey !== key) {
        footerWhereKey = key;
        footerRight.innerHTML = '';
        const line = liveLine(notulaCtx, meeting);
        if (line) footerRight.appendChild(line);
      }
      return;
    }
    footerWhereKey = '';
    const parts: string[] = [];
    if (participantCount > 0) {
      parts.push(`${participantCount} participant${participantCount !== 1 ? 's' : ''}`);
    }
    if (meeting?.startTime) {
      const elapsed = Date.now() - meeting.startTime;
      const mins = Math.floor(elapsed / 60000);
      const secs = Math.floor((elapsed % 60000) / 1000);
      parts.push(`${mins}:${String(secs).padStart(2, '0')}`);
    }
    footerRight.textContent = parts.join(' \u00b7 ');
  }

  // Update duration every second
  setInterval(updateFooter, 1000);

  // --- Meetings list view ---

  async function loadMeetingsList(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({ type: MSG.GET_MEETINGS });
      const meetingsList = (response?.meetings ?? []) as Omit<Meeting, 'entries'>[];
      meetingsEl.innerHTML = '';

      // Current meeting at top if active
      if (currentMeeting) {
        const currentItem = createMeetingListItem(currentMeeting, true);
        meetingsEl.appendChild(currentItem);
      }

      // Past meetings
      const pastMeetings = meetingsList.filter(m => m.id !== currentMeeting?.id);
      if (pastMeetings.length === 0 && !currentMeeting) {
        meetingsEl.innerHTML = '<div class="empty-state">No meetings yet</div>';
        return;
      }

      for (const m of pastMeetings) {
        meetingsEl.appendChild(createMeetingListItem(m, false));
      }
    } catch { /* silent */ }
  }

  function createMeetingListItem(m: Omit<Meeting, 'entries'> | Meeting, isCurrent: boolean): HTMLElement {
    const item = document.createElement('div');
    item.className = 'meeting-item' + (isCurrent ? ' current' : '');

    const date = new Date(m.startTime).toLocaleDateString();
    const time = new Date(m.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const participants = [...new Set(Object.values(m.participants || {}))]
      .filter(p => p !== m.meetingCode && !p.startsWith('@'));

    let durationStr: string;
    if (isCurrent) {
      const dur = Math.round((Date.now() - m.startTime) / 60000);
      durationStr = `${dur} min (live)`;
    } else if (m.endTime) {
      const dur = Math.round((m.endTime - m.startTime) / 60000);
      durationStr = `${dur} min`;
    } else {
      durationStr = '';
    }

    const showCode = m.meetingCode && m.meetingCode !== 'unknown' && m.meetingCode !== m.title;
    const codeTag = showCode ? `<span class="participant-tag">${escapeHtml(m.meetingCode)}</span>` : '';
    const participantTags = participants.map(p => `<span class="participant-tag">${escapeHtml(p)}</span>`).join('');
    const tagsHtml = (codeTag || participantTags)
      ? `<div class="meeting-item-participants">${codeTag}${participantTags}</div>`
      : '';

    item.innerHTML = `
      <div class="meeting-item-header">
        <span class="meeting-item-title">${escapeHtml(m.title)}</span>

        <div class="meeting-item-actions">
          <button class="meeting-action" data-action="rename" title="Rename">\u270E</button>
          <button class="meeting-action" data-action="copy" title="Copy as Markdown">\u2398</button>
          <button class="meeting-action" data-action="export" title="Export">\u2193</button>
          <button class="meeting-action" data-action="delete" title="Delete">\u2715</button>
        </div>
      </div>
      <div class="meeting-item-meta">${date} ${time}${durationStr ? ` \u00b7 ${durationStr}` : ''}</div>
      ${tagsHtml}
    `;

    const titleEl = item.querySelector('.meeting-item-title') as HTMLElement;
    const actionsEl = item.querySelector('.meeting-item-actions') as HTMLElement;

    // Under the name: where the call went, or why it did not. Never on the
    // live one, whose line is the footer.
    if (!isCurrent) {
      const line = saveLine(notulaCtx, m);
      if (line) item.appendChild(line);
    }

    // --- Action button handlers ---

    actionsEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'rename') {
        titleEl.contentEditable = 'true';
        titleEl.focus();
        const range = document.createRange();
        range.selectNodeContents(titleEl);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        showAutocomplete(titleEl);
      }

      if (action === 'copy') {
        chrome.runtime.sendMessage({
          type: MSG.EXPORT_MEETING,
          payload: { id: m.id, format: 'md' },
        }).then(async (response) => {
          if (response?.content) {
            await copyToClipboard(response.content, btn);
          }
        }).catch(() => {});
      }

      if (action === 'export') {
        chrome.runtime.sendMessage({
          type: MSG.EXPORT_MEETING,
          payload: { id: m.id, format: 'md' },
        }).then((response) => {
          if (response?.content) {
            download(response.content, response.title ?? m.title, response.startTime ?? m.startTime);
          }
        }).catch(() => {});
      }

      if (action === 'delete') {
        // Replace actions row with inline confirmation
        actionsEl.innerHTML = '<span class="delete-confirm">Delete? <button class="confirm-yes">Yes</button> <button class="confirm-no">No</button></span>';
        actionsEl.style.opacity = '1';

        // Refused, or answered No: the buttons come back.
        const restoreActions = (): void => {
          actionsEl.innerHTML = `
            <button class="meeting-action" data-action="rename" title="Rename">\u270E</button>
            <button class="meeting-action" data-action="copy" title="Copy as Markdown">\u2398</button>
            <button class="meeting-action" data-action="export" title="Export">\u2193</button>
            <button class="meeting-action" data-action="delete" title="Delete">\u2715</button>
          `;
          actionsEl.style.opacity = '';
        };

        actionsEl.querySelector('.confirm-yes')!.addEventListener('click', (ev) => {
          ev.stopPropagation();
          chrome.runtime.sendMessage({
            type: MSG.DELETE_MEETING,
            payload: { id: m.id },
          }).then((resp) => {
            // A call still going is refused, and saying so is the whole answer.
            if (resp && !resp.ok) {
              const line = actionsEl.querySelector('.delete-confirm');
              if (line) line.textContent = String(resp.error ?? 'Could not delete');
              setTimeout(restoreActions, 2400);
              return;
            }
            item.remove();
            // If deleted the current meeting, switch back to live view
            if (isCurrent) {
              currentMeeting = null;
              switchView('live');
            }
            // If list is now empty, show empty state
            if (meetingsEl.children.length === 0) {
              meetingsEl.innerHTML = '<div class="empty-state">No meetings yet</div>';
            }
          }).catch(() => {});
        });

        actionsEl.querySelector('.confirm-no')!.addEventListener('click', (ev) => {
          ev.stopPropagation();
          restoreActions();
        });
      }
    });

    // Click to view transcription
    item.addEventListener('click', (e) => {
      // Don't navigate if clicking on rename input or action buttons
      if ((e.target as HTMLElement).getAttribute('contenteditable') === 'true') return;
      if ((e.target as HTMLElement).closest('.meeting-item-actions')) return;
      if ((e.target as HTMLElement).closest('.where')) return;

      if (isCurrent) {
        switchView('live');
      } else {
        loadMeetingDetail(m.id, m.title);
      }
    });

    // Double-click title to rename (keep existing behavior)
    titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      titleEl.contentEditable = 'true';
      titleEl.focus();
      const range = document.createRange();
      range.selectNodeContents(titleEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      showAutocomplete(titleEl);
    });
    titleEl.addEventListener('blur', () => {
      titleEl.contentEditable = 'false';
      removeAutocomplete();
      const newTitle = titleEl.textContent?.trim();
      if (newTitle && newTitle !== m.title) {
        m.title = newTitle;
        chrome.runtime.sendMessage({
          type: MSG.RENAME_MEETING,
          payload: { id: m.id, title: newTitle },
        }).catch(() => {});
      }
    });
    titleEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (titleEl.contentEditable !== 'true') return;
      // Stop all keys from reaching Google Meet's shortcut handler
      e.stopPropagation();
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateAutocomplete(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateAutocomplete(-1); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && acIndex >= 0)) {
        e.preventDefault();
        if (acceptAutocomplete()) { titleEl.blur(); }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        titleEl.blur();
      }
      if (e.key === 'Escape') {
        titleEl.textContent = m.title;
        titleEl.blur();
      }
    });

    return item;
  }

  // --- Meeting detail view (viewing past meeting transcription) ---

  async function loadMeetingDetail(meetingId: string, title: string): Promise<void> {
    viewingMeetingId = meetingId;
    switchView('meeting-detail');
    popupTitle.textContent = title;
    detailEl.innerHTML = '<div class="loading">Loading...</div>';

    try {
      const response = await chrome.runtime.sendMessage({
        type: MSG.GET_MEETING_ENTRIES,
        meetingId,
      });
      const meetingEntries = (response?.entries ?? []) as TranscriptEntry[];
      const meetingNotes = (response?.notes ?? []) as NoteEntry[];
      detailEntries = meetingEntries;
      detailNotes = meetingNotes;
      detailTitle = title;
      detailStartTime = meetingEntries[0]?.timestamp ?? Date.now();
      detailEl.innerHTML = '';

      if (meetingEntries.length === 0) {
        detailEl.innerHTML = '<div class="empty-state">No transcription entries</div>';
        footerLeft.textContent = '0 lines';
        footerRight.textContent = '';
        return;
      }

      // Notes section (if any)
      if (meetingNotes.length > 0) {
        const notesSection = document.createElement('div');
        notesSection.className = 'detail-notes';
        notesSection.innerHTML = '<div class="detail-notes-title">Notes</div>';
        const sortedNotes = [...meetingNotes].sort((a, b) => b.timestamp - a.timestamp);
        for (const note of sortedNotes) {
          const noteDiv = document.createElement('div');
          noteDiv.className = 'note-item';
          const time = new Date(note.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          noteDiv.innerHTML = `
            <span class="note-time">${time}</span>
            <span class="note-text">${escapeHtml(note.text)}</span>
          `;
          notesSection.appendChild(noteDiv);
        }
        detailEl.appendChild(notesSection);
      }

      // Entries
      const entriesContainer = document.createElement('div');
      entriesContainer.className = 'detail-entries';
      for (const entry of meetingEntries) {
        entriesContainer.appendChild(renderEntry(entry));
      }
      detailEl.appendChild(entriesContainer);

      updateFooter();
      footerRight.textContent = '';
    } catch {
      detailEl.innerHTML = '<div class="empty-state">Failed to load meeting</div>';
    }
  }

  // --- Notula ---

  function sendNotula(message: Record<string, unknown>): void {
    try {
      port?.postMessage(message);
    } catch { /* reconnecting */ }
  }

  function startAwaiting(): void {
    if (awaitingTimer) return;
    awaitingTimer = setInterval(() => {
      const state = notulaSnapshot?.status.state ?? 'notPaired';
      sendNotula({ type: state === 'notPaired' ? 'notula_pair_start' : 'notula_check' });
    }, AWAITING_POLL_MS);
  }

  function stopAwaiting(): void {
    if (awaitingTimer) clearInterval(awaitingTimer);
    awaitingTimer = null;
  }

  function leaveScreen(): void {
    if (pairStage === 'pairing') sendNotula({ type: 'notula_pair_cancel' });
    pairStage = 'idle';
    stopAwaiting();
    renderNotula();
  }

  /** A screen takes the whole panel; when it goes, the view it covered comes back. */
  function renderScreen(): void {
    const show = renderNotulaScreen(notulaCtx, screenEl, pairStage, pairCode, {
      later: leaveScreen,
      get: () => {
        window.open(NOTULA_SITE, '_blank', 'noopener');
        pairStage = 'awaiting';
        startAwaiting();
        renderNotula();
      },
      awaiting: startAwaiting,
    });
    if (show) {
      for (const view of [liveSections, meetingsEl, detailEl, toolbarEl, backNav, footerEl, offersEl]) view.style.display = 'none';
      screenShown = true;
    } else if (screenShown) {
      screenShown = false;
      if (pairStage === 'idle' && notulaSnapshot?.status.state !== 'noWorkspace') stopAwaiting();
      applyViewDisplays();
    }
  }

  function renderNotula(): void {
    renderConnect(notulaCtx, connectOffer, connectWait, pairStage);
    renderOffers(notulaCtx, offersEl);
    renderScreen();
    footerWhereKey = '';
    updateFooter();
    if (currentView === 'meetings') void loadMeetingsList();
  }

  function onPairStage(stage: PairStage, code: string | undefined): void {
    pairStage = stageAfter(pairStage, stage);
    if (pairStage === 'pairing') pairCode = code ?? '';
    if (pairStage !== 'awaiting') stopAwaiting();
    renderNotula();
  }

  connectOffer.addEventListener('click', () => {
    connectOffer.disabled = true;
    sendNotula({ type: 'notula_pair_start' });
    setTimeout(() => {
      connectOffer.disabled = false;
    }, 4000);
  });

  // --- Communication with service worker ---

  function connectPort(): void {
    if (port) return;
    if (isContextInvalidated()) {
      showRefreshBanner();
      return;
    }
    try {
      // Include sessionId in port name so the service worker can route messages
      // even if the keepalive port hasn't reconnected yet (race after SW restart)
      const sessionId = document.documentElement.dataset.meetscribeSession;
      const portName = sessionId ? `${POPUP_PORT_NAME}:${sessionId}` : POPUP_PORT_NAME;
      port = chrome.runtime.connect(undefined, { name: portName });

      port.onMessage.addListener((message) => {
        switch (message.type) {
          case 'notula_snapshot':
            notulaSnapshot = message.snapshot as NotulaSnapshot;
            if (notulaSnapshot.status.state === 'paired' && pairStage === 'awaiting') {
              pairStage = 'idle';
              stopAwaiting();
            }
            renderNotula();
            break;

          case 'notula_save':
            if (notulaSnapshot) {
              if (message.save) notulaSnapshot.saves[message.meetingId] = message.save as NotulaSnapshot['saves'][string];
              else delete notulaSnapshot.saves[message.meetingId];
            }
            renderNotula();
            break;

          case 'notula_pair':
            onPairStage(message.stage as PairStage, message.code);
            break;

          case 'captions_missing':
            captionsMissing = true;
            renderPlaceholder();
            break;

          case 'meeting_snapshot':
            currentMeeting = message.meeting;
            entries = message.entries ?? [];
            notes = message.notes ?? [];
            if (currentMeeting) {
              participantCount = countParticipants(currentMeeting);
              if (currentView === 'live') {
                popupTitle.textContent = currentMeeting.title;
              }
            }
            renderAllEntries();
            renderAllNotes();
            break;

          case 'new_entry':
            entries.push(message.entry);
            appendEntry(message.entry);
            break;

          case 'entry_updated':
            updateEntryInPlace(message.entry);
            {
              const idx = entries.findIndex(e => e.id === message.entry.id);
              if (idx >= 0) entries[idx] = message.entry;
            }
            break;

          case 'transcript_cleared':
            entries = [];
            transcriptEl.innerHTML = '';
            updateFooter();
            break;

          case 'meeting_started':
            currentMeeting = message.meeting;
            participantCount = 0;
            notes = [];
            captionsMissing = false;
            renderAllNotes();
            renderPlaceholder();
            if (currentView === 'live') {
              popupTitle.textContent = currentMeeting?.title ?? 'Live';
            }
            break;

          case 'meeting_ended':
            currentMeeting = null;
            participantCount = 0;
            notes = [];
            renderAllNotes();
            renderPlaceholder();
            if (currentView === 'live') {
              popupTitle.textContent = 'Live';
              updateFooter();
            }
            if (currentView === 'meetings') {
              loadMeetingsList();
            }
            break;

          case 'participant_update':
            if (currentMeeting) {
              if (!currentMeeting.participants) currentMeeting.participants = {};
              currentMeeting.participants[message.deviceId] = message.deviceName;
              participantCount = countParticipants(currentMeeting);
              updateFooter();
            }
            break;

          case 'meeting_renamed':
            if (currentMeeting && message.meeting?.id === currentMeeting.id) {
              currentMeeting.title = message.meeting.title;
              if (currentView === 'live') {
                popupTitle.textContent = currentMeeting.title;
              }
            }
            break;

          case 'note_added':
            notes.unshift(message.note);
            if (currentView === 'live') {
              notesList.prepend(renderNoteItem(message.note));
              updateFooter();
            }
            break;

          case 'note_updated': {
            const idx = notes.findIndex(n => n.id === message.note.id);
            if (idx >= 0) notes[idx] = message.note;
            if (currentView === 'live') {
              const el = notesList.querySelector(`[data-note-id="${message.note.id}"] .note-text`);
              if (el && el !== shadow.activeElement) {
                el.textContent = message.note.text;
              }
            }
            break;
          }

          case 'note_deleted':
            notes = notes.filter(n => n.id !== message.noteId);
            if (currentView === 'live') {
              const noteEl = notesList.querySelector(`[data-note-id="${message.noteId}"]`);
              if (noteEl) noteEl.remove();
            }
            break;
        }
      });

      port.onDisconnect.addListener(() => {
        port = null;
        if (isContextInvalidated()) {
          showRefreshBanner();
        } else {
          setTimeout(connectPort, 2000);
        }
      });
    } catch {
      if (isContextInvalidated()) {
        showRefreshBanner();
      } else {
        setTimeout(connectPort, 5000);
      }
    }
  }

  // --- Position & size persistence ---

  async function restorePosition(): Promise<void> {
    try {
      const result = await chrome.storage.local.get([STORAGE_POS_KEY, STORAGE_SIZE_KEY]);
      const pos = result[STORAGE_POS_KEY];
      if (pos && typeof pos === 'object') {
        host.style.left = pos.left ?? 'auto';
        host.style.top = pos.top ?? 'auto';
        host.style.right = pos.right ?? 'auto';
        host.style.bottom = pos.bottom ?? 'auto';
      } else {
        host.style.right = '20px';
        host.style.top = '20px';
      }

      const size = result[STORAGE_SIZE_KEY];
      if (size && typeof size === 'object') {
        popupWidth = size.width ?? DEFAULT_WIDTH;
        popupHeight = size.height ?? DEFAULT_HEIGHT;
      }
      applySize();
    } catch {
      host.style.right = '20px';
      host.style.top = '20px';
      applySize();
    }
  }

  function savePosition(): void {
    if (isContextInvalidated()) return;
    chrome.storage.local.set({
      [STORAGE_POS_KEY]: {
        left: host.style.left,
        top: host.style.top,
        right: host.style.right,
        bottom: host.style.bottom,
      },
    }).catch(() => {});
  }

  function saveSize(): void {
    if (isContextInvalidated()) return;
    chrome.storage.local.set({
      [STORAGE_SIZE_KEY]: { width: popupWidth, height: popupHeight },
    }).catch(() => {});
  }

  // --- Inject into page ---

  function inject(): void {
    document.body.appendChild(host);
    restorePosition();
    connectPort();
    updateStyles();
  }

  if (document.body) {
    inject();
  } else {
    document.addEventListener('DOMContentLoaded', inject);
  }

  // --- Styles ---

  function updateStyles(): void {
    styleEl.textContent = getStyles();
  }

  function getStyles(): string {
    return `
      :host {
        all: initial;
      }

      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      [hidden] {
        display: none !important;
      }

      /* Notula's palette, inlined: the panel lives inside somebody else's page
         and cannot import the app's stylesheet, so the same tokens are written
         here once, light and dark, and every rule below reads them. */
      .popup {
        --bg: #fdfdfb;
        --bg-sunken: #f6f5f1;
        --bg-raised: #fffffd;
        --bg-hover: rgba(28, 28, 26, 0.05);
        --bg-active: rgba(176, 86, 58, 0.12);
        --border: #e2e0d8;
        --border-strong: #cfccc0;
        --text: #1c1c1a;
        --text-dim: #6f6d65;
        --text-faint: #8b8981;
        --accent: #b0563a;
        --accent-text: #fff;
        --warning-bg: #f6ecd8;
        --warning-border: #e0cb96;
        --warning-text: #6b5312;
        --danger: #a83a2a;
        --comment: rgba(176, 86, 58, 0.18);
        --comment-strong: rgba(176, 86, 58, 0.38);
        --shadow: 0 1px 2px rgba(28, 28, 26, 0.05), 0 8px 24px -14px rgba(28, 28, 26, 0.28);
        --font-ui: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
        --font-code: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
        --radius: 6px;
        --radius-lg: 10px;
        --quick: 120ms;
        --ease: cubic-bezier(0.2, 0.7, 0.2, 1);

        position: relative;
        display: flex;
        flex-direction: column;
        width: ${DEFAULT_WIDTH}px;
        height: ${DEFAULT_HEIGHT}px;
        overflow: hidden;
        font-family: var(--font-ui);
        font-size: 12px;
        line-height: 1.4;
        color: var(--text);
        background: var(--bg-raised);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow);
      }

      @media (prefers-color-scheme: dark) {
        .popup {
          --bg: #1c1c1a;
          --bg-sunken: #171715;
          --bg-raised: #22221f;
          --bg-hover: rgba(242, 241, 236, 0.06);
          --bg-active: rgba(210, 121, 90, 0.18);
          --border: #383833;
          --border-strong: #4c4c45;
          --text: #f2f1ec;
          --text-dim: #a3a199;
          --text-faint: #7d7b73;
          --accent: #d2795a;
          --accent-text: #1c1c1a;
          --warning-bg: #3a3222;
          --warning-border: #5c4f2e;
          --warning-text: #e3cb96;
          --danger: #e08476;
          --comment: rgba(210, 121, 90, 0.2);
          --comment-strong: rgba(210, 121, 90, 0.42);
          --shadow: 0 8px 30px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.4);
        }
      }

      .popup.minimized {
        height: auto !important;
        width: auto !important;
        min-width: 160px;
      }

      button {
        font: inherit;
        color: inherit;
        background: none;
        border: 0;
        cursor: pointer;
      }

      button:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
      }

      /* A field being typed into keeps its own edge and colours it: a ring
         around a box is two edges, and the outer one is what a scroller clips. */
      input:focus-visible,
      select:focus-visible,
      textarea:focus-visible {
        border-color: var(--accent);
        outline: none;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 36px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
      }

      .drag-handle {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        cursor: grab;
        user-select: none;
      }

      .drag-handle:active {
        cursor: grabbing;
      }

      .title {
        display: block;
        overflow: hidden;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: -0.01em;
        white-space: nowrap;
        text-overflow: ellipsis;
        outline: none;
        border-radius: 4px;
        padding: 1px 3px;
        margin: -1px -3px;
      }

      .title-prefix {
        color: var(--text);
      }

      .title-sep {
        color: var(--text-faint);
      }

      .title-page {
        font-weight: 500;
        color: var(--text-dim);
        outline: none;
        border-radius: 4px;
        padding: 1px 3px;
        margin: -1px -3px;
      }

      .title-page[contenteditable="true"] {
        color: var(--text);
        background: var(--bg-sunken);
        outline: 1px solid var(--accent);
        white-space: normal;
        cursor: text;
      }

      .autocomplete-list {
        position: absolute;
        z-index: 1000;
        max-height: 120px;
        overflow-y: auto;
        padding: 4px;
        background: var(--bg-raised);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
      }

      .autocomplete-list:empty {
        display: none;
      }

      .autocomplete-item {
        padding: 5px 8px;
        overflow: hidden;
        font-size: 12px;
        color: var(--text);
        white-space: nowrap;
        text-overflow: ellipsis;
        border-radius: 4px;
        cursor: pointer;
      }

      .autocomplete-item:hover,
      .autocomplete-item.active {
        background: var(--bg-hover);
      }

      .header-actions {
        display: flex;
        gap: 2px;
        flex-shrink: 0;
      }

      .btn-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        font-size: 15px;
        color: var(--text-dim);
        border-radius: 5px;
        transition: background-color var(--quick) var(--ease), color var(--quick) var(--ease);
      }

      .btn-icon:hover {
        color: var(--text);
        background: var(--bg-hover);
      }

      .btn-icon.active {
        color: var(--accent);
        background: var(--bg-active);
      }

      .btn-icon svg {
        width: 14px;
        height: 14px;
      }

      /* The connection line under the header. An offer is a button; a wait is
         a band with nothing to press, because there is nothing to do. */
      .connect {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 10px;
        font-size: 11px;
        text-align: start;
        color: var(--accent);
        background: var(--bg-sunken);
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
        transition: background-color var(--quick) var(--ease);
      }

      .connect:hover {
        background: var(--bg-hover);
      }

      .connect:disabled {
        opacity: 0.6;
        cursor: default;
      }

      .connect.warning,
      .connect.warning:hover {
        color: var(--warning-text);
        background: var(--warning-bg);
        border-bottom-color: var(--warning-border);
        cursor: default;
      }

      .connect svg {
        flex: none;
        width: 12px;
        height: 12px;
      }

      .body {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }

      .toolbar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
      }

      .lang-select {
        flex: 1;
        min-width: 0;
        height: 26px;
        padding: 0 8px;
        font: inherit;
        font-size: 11px;
        color: var(--text-dim);
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        outline: none;
        cursor: pointer;
      }

      .lang-select:focus {
        border-color: var(--accent);
      }

      .lang-select option {
        color: var(--text);
        background: var(--bg-raised);
      }

      .btn-small {
        height: 26px;
        padding: 0 10px;
        font-size: 11px;
        color: var(--text-dim);
        white-space: nowrap;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        transition: background-color var(--quick) var(--ease), color var(--quick) var(--ease);
      }

      .btn-small:hover {
        color: var(--text);
        background: var(--bg-hover);
      }

      .toolbar-action {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 26px;
        height: 26px;
        padding: 0;
        color: var(--text-dim);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        transition: background-color var(--quick) var(--ease), color var(--quick) var(--ease);
      }

      .toolbar-action:hover {
        color: var(--text);
        background: var(--bg-hover);
      }

      .section {
        border-bottom: 1px solid var(--border);
      }

      .section:last-child {
        border-bottom: none;
      }

      .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        cursor: pointer;
        user-select: none;
        transition: background-color var(--quick) var(--ease);
      }

      .section-header:hover {
        background: var(--bg-hover);
      }

      .section-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-dim);
      }

      .section-chevron {
        font-size: 9px;
        color: var(--text-faint);
      }

      .section-body {
        padding: 0 10px 8px;
      }

      .notes-input-row {
        display: flex;
        gap: 6px;
        margin-bottom: 6px;
      }

      .notes-input {
        flex: 1;
        min-width: 0;
        height: 26px;
        padding: 0 8px;
        font: inherit;
        font-size: 12px;
        color: var(--text);
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        outline: none;
      }

      .notes-input:focus {
        border-color: var(--accent);
      }

      .notes-input::placeholder {
        color: var(--text-faint);
      }

      .btn-add-note {
        flex-shrink: 0;
      }

      .notes-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      /* A note is the person's own words over the call, marked the way a
         comment marks a passage in Notula - the same tint, not a second colour. */
      .note-item {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        padding: 4px 6px 4px 8px;
        font-size: 12px;
        background: var(--comment);
        border-left: 2px solid var(--comment-strong);
        border-radius: 0 var(--radius) var(--radius) 0;
      }

      .note-time {
        flex-shrink: 0;
        margin-top: 1px;
        font-size: 10px;
        font-variant-numeric: tabular-nums;
        color: var(--text-faint);
      }

      .note-text {
        flex: 1;
        padding: 0 2px;
        line-height: 1.4;
        color: var(--text);
        word-break: break-word;
        border-radius: 3px;
        outline: none;
        cursor: text;
      }

      .note-text[contenteditable="true"] {
        background: var(--bg-raised);
        outline: 1px solid var(--accent);
      }

      .note-delete {
        flex-shrink: 0;
        padding: 0 2px;
        font-size: 10px;
        color: var(--text-faint);
        opacity: 0;
        transition: opacity var(--quick) var(--ease), color var(--quick) var(--ease);
      }

      .note-item:hover .note-delete,
      .note-delete:focus-visible {
        opacity: 1;
      }

      .note-delete:hover {
        color: var(--danger);
      }

      .content-area {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }

      .live-sections {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }

      #section-notes {
        flex-shrink: 0;
      }

      #section-notes .section-body {
        max-height: 150px;
        overflow-y: auto;
      }

      #section-transcript {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }

      #section-transcript .section-body {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }

      .transcript {
        flex: 1;
        padding: 0;
        overflow-y: auto;
        scroll-behavior: smooth;
      }

      .placeholder {
        padding: 24px 10px;
        font-size: 11px;
        text-align: center;
        color: var(--text-faint);
      }

      .meetings-view,
      .detail-view {
        flex: 1;
        padding: 6px 6px 8px;
        overflow-y: auto;
        scroll-behavior: smooth;
      }

      #section-notes .section-body::-webkit-scrollbar,
      .transcript::-webkit-scrollbar,
      .meetings-view::-webkit-scrollbar,
      .detail-view::-webkit-scrollbar,
      .menu::-webkit-scrollbar {
        width: 4px;
      }

      #section-notes .section-body::-webkit-scrollbar-track,
      .transcript::-webkit-scrollbar-track,
      .meetings-view::-webkit-scrollbar-track,
      .detail-view::-webkit-scrollbar-track,
      .menu::-webkit-scrollbar-track {
        background: transparent;
      }

      #section-notes .section-body::-webkit-scrollbar-thumb,
      .transcript::-webkit-scrollbar-thumb,
      .meetings-view::-webkit-scrollbar-thumb,
      .detail-view::-webkit-scrollbar-thumb,
      .menu::-webkit-scrollbar-thumb {
        background: var(--border-strong);
        border-radius: 2px;
      }

      .entry {
        margin-bottom: 4px;
        padding: 6px 0;
        border-bottom: 1px solid var(--border);
        animation: fadeIn var(--quick) var(--ease);
      }

      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @media (prefers-reduced-motion: reduce) {
        .entry {
          animation: none;
        }
      }

      .entry:last-child {
        border-bottom: none;
      }

      .speaker {
        margin-right: 6px;
        font-size: 10px;
        font-weight: 600;
        color: var(--text-dim);
      }

      .time {
        font-size: 10px;
        font-variant-numeric: tabular-nums;
        color: var(--text-faint);
      }

      .device-id {
        display: block;
        max-width: 100%;
        overflow: hidden;
        font-family: var(--font-code);
        font-size: 9px;
        color: var(--text-faint);
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .text {
        margin-top: 2px;
        font-size: 12px;
        line-height: 1.5;
        color: var(--text);
        word-break: break-word;
      }

      .footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 28px;
        padding: 3px 10px;
        font-size: 11px;
        color: var(--text-dim);
        background: var(--bg-sunken);
        border-top: 1px solid var(--border);
        flex-shrink: 0;
      }

      #footer-left {
        flex: none;
        white-space: nowrap;
      }

      #footer-right {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 4px;
        min-width: 0;
      }

      /* Where a meeting went, or why it did not: under its name on a card, at
         the end of the footer on the live one. The folder is the one thing on
         the line that is pressed, so it is the one thing drawn as a control. */
      .where {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 22px;
        min-width: 0;
        margin-top: 4px;
        font-size: 11px;
        color: var(--text-dim);
      }

      .footer .where {
        margin-top: 0;
      }

      .where svg {
        flex: none;
        width: 12px;
        height: 12px;
        color: var(--text-faint);
      }

      .where .what {
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .where.with-dest .what {
        flex: none;
      }

      .where.warning {
        color: var(--warning-text);
      }

      .where.danger {
        color: var(--danger);
      }

      .where .dest {
        display: inline-flex;
        flex: 0 1 auto;
        align-items: center;
        gap: 4px;
        min-width: 48px;
        padding: 1px 6px;
        overflow: hidden;
        font-family: var(--font-code);
        font-size: 11px;
        color: var(--text);
        white-space: nowrap;
        background: var(--bg-sunken);
        border: 1px solid var(--border);
        border-radius: 5px;
        transition: background-color var(--quick) var(--ease), border-color var(--quick) var(--ease);
      }

      /* The repository gives way first: it is recognisable from its first letters,
         and the folder is what tells two meetings apart. */
      .where .dest .repo {
        flex: 1 1 0;
        min-width: 2ch;
        max-width: max-content;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--text-dim);
      }

      .where .dest .sep {
        flex: none;
        color: var(--text-faint);
      }

      .where .dest .folder {
        flex: 0 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .footer .where .dest {
        background: var(--bg-raised);
      }

      .where .dest:hover {
        background: var(--bg-hover);
        border-color: var(--border-strong);
      }

      /* Nowhere chosen yet: a chip with nothing in it, drawn as the gap it is. */
      .where .dest.empty {
        font-family: var(--font-ui);
        color: var(--text-dim);
        border-style: dashed;
      }

      .where .acts {
        display: flex;
        flex-shrink: 0;
        gap: 2px;
        margin-left: auto;
      }

      .where .acts button {
        padding: 2px 6px;
        font-size: 11px;
        color: var(--accent);
        border-radius: 5px;
        transition: background-color var(--quick) var(--ease);
      }

      .where .acts button:hover {
        background: var(--bg-hover);
      }

      /* A screen says one thing and offers one way out. */
      .screen {
        padding: 20px 16px;
      }

      .screen.centre {
        text-align: center;
      }

      .screen h3 {
        margin-bottom: 6px;
        font-size: 12px;
        font-weight: 600;
        color: var(--text);
      }

      .screen p {
        font-size: 11px;
        line-height: 1.5;
        color: var(--text-dim);
      }

      /* Not scoped to the screen: the same line sits in the footer of the list,
         which is the only place somebody already paired can find it. */
      .why {
        color: var(--accent);
        text-decoration: none;
        border-bottom: 1px solid transparent;
      }

      .why:hover {
        border-bottom-color: currentColor;
      }

      /* In the footer it is the quietest thing on the surface, because the accent
         on this list already belongs to Save to Notula and Open. */
      .footer .why {
        color: var(--text-dim);
      }

      .footer .why:hover {
        color: var(--accent);
      }

      .screen .actions,
      .offer .actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        margin-top: 14px;
      }

      .screen .code {
        display: block;
        margin: 8px 0 12px;
        font-family: var(--font-code);
        font-size: 20px;
        font-weight: 600;
        letter-spacing: 0.18em;
        color: var(--text);
      }

      .steps {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 10px;
        padding-left: 0;
        font-size: 11px;
        line-height: 1.5;
        color: var(--text-dim);
        list-style: none;
        counter-reset: step;
      }

      .steps li {
        display: flex;
        align-items: baseline;
        gap: 8px;
      }

      .steps li::before {
        content: counter(step);
        counter-increment: step;
        display: inline-grid;
        flex: none;
        place-items: center;
        width: 16px;
        height: 16px;
        font-size: 10px;
        color: var(--text-dim);
        border: 1px solid var(--border-strong);
        border-radius: 50%;
      }

      .primary {
        padding: 4px 10px;
        font-size: 11px;
        font-weight: 500;
        color: var(--accent-text);
        background: var(--accent);
        border-radius: var(--radius);
        transition: opacity var(--quick) var(--ease);
      }

      .primary:hover {
        opacity: 0.92;
      }

      .ghost {
        padding: 4px 10px;
        font-size: 11px;
        color: var(--text-dim);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        transition: background-color var(--quick) var(--ease), color var(--quick) var(--ease);
      }

      .ghost:hover {
        color: var(--text);
        background: var(--bg-hover);
      }

      /* The two cards that show once: the rename, and the backlog after the first pairing. */
      .offer {
        margin: 8px 10px 0;
        padding: 8px 10px;
        background: var(--bg-sunken);
        border: 1px solid var(--border);
        border-radius: 8px;
      }

      .offer .head {
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }

      .offer .what {
        flex: 1;
        font-size: 12px;
        font-weight: 600;
        color: var(--text);
      }

      .offer .dismiss {
        display: grid;
        flex: none;
        place-items: center;
        width: 20px;
        height: 20px;
        margin: -2px -4px 0 0;
        font-size: 14px;
        color: var(--text-faint);
        border-radius: 4px;
      }

      .offer .dismiss:hover {
        color: var(--text);
        background: var(--bg-hover);
      }

      .offer p {
        margin-top: 4px;
        font-size: 11px;
        line-height: 1.5;
        color: var(--text-dim);
      }

      .offer .actions {
        margin-top: 8px;
      }

      /* The surface a picker is drawn on. */
      .menu {
        position: absolute;
        z-index: 1001;
        min-width: 170px;
        max-height: 220px;
        padding: 4px;
        overflow-y: auto;
        background: var(--bg-raised);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
      }

      .menu .item {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 5px 8px;
        font-family: var(--font-code);
        font-size: 11px;
        color: var(--text);
        text-align: start;
        border-radius: 4px;
      }

      .menu .item svg {
        flex: none;
        width: 12px;
        height: 12px;
        color: var(--text-faint);
      }

      .menu .item:hover {
        background: var(--bg-hover);
      }

      .menu .item.on {
        color: var(--accent);
        background: var(--bg-active);
      }

      .menu .item.plain {
        font-family: var(--font-ui);
        color: var(--text-dim);
      }

      .menu .rule {
        height: 1px;
        margin: 4px 0;
        background: var(--border);
      }

      /* The destination picker: the repository across the top, its folders as a
         tree under it, and a field that filters them or names a new one. */
      .menu.picker {
        display: flex;
        flex-direction: column;
        left: 8px;
        right: 8px;
        min-width: 0;
        padding: 0;
        overflow: hidden;
      }

      .picker .head {
        display: flex;
        flex: none;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 7px 10px;
        font-size: 11px;
        font-weight: 600;
        color: var(--text);
        text-align: start;
        border-bottom: 1px solid var(--border);
        transition: background-color var(--quick) var(--ease);
      }

      .picker .head:hover {
        background: var(--bg-hover);
      }

      .picker .head svg {
        flex: none;
        width: 12px;
        height: 12px;
        color: var(--text-faint);
      }

      .picker .head svg:last-child {
        transform: rotate(90deg);
        transition: transform var(--quick) var(--ease);
      }

      .picker .head.open svg:last-child {
        transform: rotate(-90deg);
      }

      .picker .name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .picker .filter {
        flex: none;
        margin: 6px 6px 2px;
        padding: 4px 8px;
        font: inherit;
        font-size: 11px;
        color: var(--text);
        background: var(--bg-sunken);
        border: 1px solid var(--border);
        border-radius: 5px;
        outline: none;
        transition: border-color var(--quick) var(--ease);
      }

      .picker .filter:focus {
        border-color: var(--border-strong);
      }

      .picker .filter::placeholder {
        color: var(--text-faint);
      }

      .picker .body {
        flex: 1 1 auto;
        min-height: 0;
        padding: 4px;
        overflow-y: auto;
      }

      .picker .row {
        padding-left: calc(6px + var(--depth, 0) * 14px);
      }

      .picker .row.cursor {
        background: var(--bg-hover);
      }

      .picker .row.on.cursor {
        background: var(--bg-active);
      }

      .picker .chev {
        display: flex;
        flex: none;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        margin: -3px -4px -3px -5px;
        color: var(--text-faint);
        border-radius: 3px;
      }

      .picker .chev svg {
        width: 10px;
        height: 10px;
        transition: transform var(--quick) var(--ease);
      }

      .picker .chev.open svg {
        transform: rotate(90deg);
      }

      .picker .chev.none {
        visibility: hidden;
      }

      .picker .chev:hover {
        color: var(--text);
        background: var(--bg-active);
      }

      .picker .tag {
        flex: none;
        padding: 0 4px;
        font-family: var(--font-ui);
        font-size: 9px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--text-faint);
        border: 1px solid var(--border);
        border-radius: 3px;
      }

      .picker .create .name {
        font-family: var(--font-ui);
        color: var(--text-dim);
      }

      .picker .create b {
        font-family: var(--font-code);
        font-weight: 400;
        color: var(--text);
      }

      .picker .foot {
        flex: none;
        padding: 6px 10px;
        white-space: normal;
        border-top: 1px solid var(--border);
        border-radius: 0;
      }

      /* Resize edges & corners */
      .edge { position: absolute; z-index: 10; }
      .edge-n { top: -3px; left: 6px; right: 6px; height: 6px; cursor: ns-resize; }
      .edge-s { bottom: -3px; left: 6px; right: 6px; height: 6px; cursor: ns-resize; }
      .edge-w { left: -3px; top: 6px; bottom: 6px; width: 6px; cursor: ew-resize; }
      .edge-e { right: -3px; top: 6px; bottom: 6px; width: 6px; cursor: ew-resize; }
      .edge-nw { top: -3px; left: -3px; width: 10px; height: 10px; cursor: nwse-resize; }
      .edge-ne { top: -3px; right: -3px; width: 10px; height: 10px; cursor: nesw-resize; }
      .edge-sw { bottom: -3px; left: -3px; width: 10px; height: 10px; cursor: nesw-resize; }
      .edge-se { bottom: -3px; right: -3px; width: 10px; height: 10px; cursor: nwse-resize; }

      /* Meetings list */
      .meeting-item {
        margin-bottom: 2px;
        padding: 8px 10px;
        border-radius: 8px;
        cursor: pointer;
        transition: background-color var(--quick) var(--ease);
      }

      .meeting-item:hover {
        background: var(--bg-hover);
      }

      .meeting-item.current {
        background: var(--bg-active);
      }

      .meeting-item-header {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .meeting-item-title {
        flex: 1;
        min-width: 0;
        padding: 1px 3px;
        margin: -1px -3px;
        overflow: hidden;
        font-size: 12px;
        font-weight: 600;
        color: var(--text);
        white-space: nowrap;
        text-overflow: ellipsis;
        border-radius: 3px;
        outline: none;
      }

      .meeting-item-title[contenteditable="true"] {
        white-space: normal;
        background: var(--bg-sunken);
        outline: 1px solid var(--accent);
      }

      /* Live is a dot, not a badge: the card already says so in its shade. */
      .live-badge {
        flex-shrink: 0;
        width: 6px;
        height: 6px;
        overflow: hidden;
        font-size: 0;
        color: transparent;
        background: var(--accent);
        border-radius: 50%;
      }

      .meeting-item-meta {
        margin-top: 2px;
        font-size: 11px;
        color: var(--text-faint);
      }

      .back-nav {
        padding: 4px 10px;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
      }

      .btn-back-live {
        padding: 2px 0;
        font-size: 11px;
        color: var(--text-dim);
        transition: color var(--quick) var(--ease);
      }

      .btn-back-live:hover {
        color: var(--accent);
      }

      .meeting-item-participants {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
      }

      .participant-tag {
        /* A name Meet got wrong can be a whole sentence, and one that cannot
           shrink widens the card and puts a scrollbar under the whole list. */
        max-width: 100%;
        overflow: hidden;
        padding: 1px 6px;
        font-size: 10px;
        color: var(--text-dim);
        text-overflow: ellipsis;
        white-space: nowrap;
        background: var(--bg-sunken);
        border: 1px solid var(--border);
        border-radius: 8px;
      }

      .meeting-item-actions {
        display: flex;
        flex-shrink: 0;
        gap: 2px;
        margin-left: auto;
        opacity: 0;
        transition: opacity var(--quick) var(--ease);
      }

      .meeting-item:hover .meeting-item-actions,
      .meeting-item:focus-within .meeting-item-actions {
        opacity: 1;
      }

      .meeting-action {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 0;
        font-size: 12px;
        color: var(--text-dim);
        border-radius: 5px;
        transition: background-color var(--quick) var(--ease), color var(--quick) var(--ease);
      }

      .meeting-action:hover {
        color: var(--text);
        background: var(--bg-hover);
      }

      .meeting-action[data-action="delete"]:hover {
        color: var(--danger);
      }

      .delete-confirm {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--danger);
      }

      .confirm-yes,
      .confirm-no {
        padding: 2px 8px;
        font-size: 11px;
        color: var(--text-dim);
        border: 1px solid var(--border);
        border-radius: 5px;
        transition: background-color var(--quick) var(--ease), color var(--quick) var(--ease);
      }

      .confirm-yes:hover {
        color: var(--danger);
        background: var(--bg-hover);
      }

      .confirm-no:hover {
        color: var(--text);
        background: var(--bg-hover);
      }

      /* Detail view */
      .btn-back {
        display: block;
        margin-bottom: 8px;
        padding: 6px 0;
        font-size: 12px;
        color: var(--accent);
      }

      .btn-back:hover {
        text-decoration: underline;
      }

      .detail-notes {
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--border);
      }

      .detail-notes-title {
        margin-bottom: 6px;
        font-size: 11px;
        font-weight: 600;
        color: var(--text-dim);
      }

      .detail-notes .note-item {
        margin-bottom: 4px;
      }

      .empty-state,
      .loading {
        padding: 40px 0;
        font-size: 12px;
        text-align: center;
        color: var(--text-faint);
      }
    `;
  }
})();
