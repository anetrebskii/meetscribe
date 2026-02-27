import { MSG, POPUP_PORT_NAME, type TranscriptEntry, type Meeting } from '../utils/types';
import { LANGUAGE_CODES } from '../utils/constants';

(function () {
  const STORAGE_POS_KEY = 'popup_position';
  const STORAGE_SIZE_KEY = 'popup_size';
  const DEFAULT_WIDTH = 350;
  const DEFAULT_HEIGHT = 400;
  const MIN_WIDTH = 280;
  const MIN_HEIGHT = 200;

  let port: chrome.runtime.Port | null = null;
  let entries: TranscriptEntry[] = [];
  let currentMeeting: Meeting | null = null;
  let participantCount = 0;
  let isMinimized = false;
  let isHidden = true; // Start hidden, show on icon click
  let isDragging = false;
  let isResizing = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartW = 0;
  let resizeStartH = 0;
  let autoScroll = true;
  let currentView: 'live' | 'meetings' | 'meeting-detail' = 'live';
  let viewingMeetingId: string | null = null;
  let popupWidth = DEFAULT_WIDTH;
  let popupHeight = DEFAULT_HEIGHT;

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
        <span class="title"><span class="title-prefix">MeetScribe</span> <span class="title-sep">–</span> <span class="title-page" id="popup-title">Live</span></span>
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
    <div class="body" id="body">
      <div class="toolbar" id="toolbar">
        <select class="lang-select" id="lang-select"></select>
        <button class="btn-small" id="btn-copy" title="Copy as Markdown">Copy</button>
        <button class="btn-small" id="btn-export" title="Export transcript">Export</button>
      </div>
      <div class="back-nav" id="back-nav">
        <button class="btn-back-live" id="btn-back-live">&larr; Meetings</button>
      </div>
      <div class="content-area" id="content-area">
        <div class="transcript" id="transcript"></div>
        <div class="meetings-view" id="meetings-view" style="display:none"></div>
        <div class="detail-view" id="detail-view" style="display:none"></div>
      </div>
      <div class="footer" id="footer">
        <span id="footer-left">0 entries</span>
        <span id="footer-right"></span>
      </div>
    </div>
    <div class="resize-handle" id="resize-handle"></div>
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
  const resizeHandle = shadow.getElementById('resize-handle')!;
  const toolbarEl = shadow.getElementById('toolbar')!;
  const footerEl = shadow.getElementById('footer')!;
  const backNav = shadow.getElementById('back-nav')!;
  const btnBackLive = shadow.getElementById('btn-back-live')!;

  btnBackLive.addEventListener('click', () => {
    switchView('meetings');
  });

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
    resizeHandle.style.display = isMinimized ? 'none' : '';
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
    const orig = feedbackEl.textContent;
    feedbackEl.textContent = '\u2713';
    feedbackEl.title = 'Copied!';
    setTimeout(() => {
      feedbackEl.textContent = orig;
      feedbackEl.title = 'Copy as Markdown';
    }, 1500);
  }

  btnCopy.addEventListener('click', async () => {
    try {
      const title = currentMeeting?.title ?? 'Meeting Transcript';
      const response = await chrome.runtime.sendMessage({
        type: MSG.EXPORT_TRANSCRIPT,
        payload: { format: 'md', title },
      });
      if (response?.content) {
        await copyToClipboard(response.content, btnCopy);
      }
    } catch { /* silent */ }
  });

  btnExport.addEventListener('click', async () => {
    try {
      const title = currentMeeting?.title ?? 'Meeting Transcript';
      const response = await chrome.runtime.sendMessage({
        type: MSG.EXPORT_TRANSCRIPT,
        payload: { format: 'md', title },
      });
      if (response?.content) {
        const blob = new Blob([response.content], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safeName = title.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
        const d = new Date(currentMeeting?.startTime ?? Date.now());
        const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
        a.download = `${safeName} ${dateStr}.md`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch { /* silent */ }
  });

  // --- View switching ---

  function switchView(view: typeof currentView): void {
    currentView = view;
    transcriptEl.style.display = view === 'live' ? '' : 'none';
    meetingsEl.style.display = view === 'meetings' ? '' : 'none';
    detailEl.style.display = view === 'meeting-detail' ? '' : 'none';
    toolbarEl.style.display = view === 'live' ? '' : 'none';
    backNav.style.display = (view === 'live' || view === 'meeting-detail') ? '' : 'none';

    btnMeetings.classList.toggle('active', view === 'meetings' || view === 'meeting-detail');

    switch (view) {
      case 'live':
        popupTitle.textContent = currentMeeting ? currentMeeting.title : 'Live';
        updateFooter();
        break;
      case 'meetings':
        popupTitle.textContent = 'Meetings';
        footerLeft.textContent = '';
        footerRight.textContent = '';
        loadMeetingsList();
        break;
      case 'meeting-detail':
        // title set by loadMeetingDetail
        break;
    }
  }

  // --- Toggle popup visibility (from toolbar icon) ---

  chrome.runtime.onMessage.addListener((message): undefined => {
    if (message.type === MSG.TOGGLE_POPUP) {
      isHidden = !isHidden;
      host.style.display = isHidden ? 'none' : '';
      if (!isHidden && !port) {
        connectPort();
      }
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
      const dw = e.clientX - resizeStartX;
      const dh = e.clientY - resizeStartY;
      popupWidth = Math.max(MIN_WIDTH, resizeStartW + dw);
      popupHeight = Math.max(MIN_HEIGHT, resizeStartH + dh);
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
    }
  });

  // --- Resizing ---

  resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartW = popupWidth;
    resizeStartH = popupHeight;
    e.preventDefault();
    e.stopPropagation();
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

  function appendEntry(entry: TranscriptEntry): void {
    // Only append if viewing live
    if (currentView !== 'live') return;
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
    updateFooter();
    if (autoScroll) {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }
  }

  function updateFooter(): void {
    if (currentView !== 'live' && currentView !== 'meeting-detail') return;
    footerLeft.textContent = `${entries.length} entries`;

    const meeting = currentView === 'live' ? currentMeeting : null;
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
    const participants = [...new Set(Object.values(m.participants || {}))];

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
            const blob = new Blob([response.content], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const title = (response.title ?? m.title).replace(/[^a-zA-Z0-9 _-]/g, '').trim();
            const d = new Date(response.startTime ?? m.startTime);
            const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
            a.download = `${title} ${dateStr}.md`;
            a.click();
            URL.revokeObjectURL(url);
          }
        }).catch(() => {});
      }

      if (action === 'delete') {
        // Replace actions row with inline confirmation
        actionsEl.innerHTML = '<span class="delete-confirm">Delete? <button class="confirm-yes">Yes</button> <button class="confirm-no">No</button></span>';
        actionsEl.style.opacity = '1';

        actionsEl.querySelector('.confirm-yes')!.addEventListener('click', (ev) => {
          ev.stopPropagation();
          chrome.runtime.sendMessage({
            type: MSG.DELETE_MEETING,
            payload: { id: m.id },
          }).then((resp) => {
            if (resp && !resp.ok) { loadMeetingsList(); return; }
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
          // Restore original action buttons
          actionsEl.innerHTML = `
            <button class="meeting-action" data-action="rename" title="Rename">\u270E</button>
            <button class="meeting-action" data-action="copy" title="Copy as Markdown">\u2398</button>
            <button class="meeting-action" data-action="export" title="Export">\u2193</button>
            <button class="meeting-action" data-action="delete" title="Delete">\u2715</button>
          `;
          actionsEl.style.opacity = '';
        });
      }
    });

    // Click to view transcription
    item.addEventListener('click', (e) => {
      // Don't navigate if clicking on rename input or action buttons
      if ((e.target as HTMLElement).getAttribute('contenteditable') === 'true') return;
      if ((e.target as HTMLElement).closest('.meeting-item-actions')) return;

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
      detailEl.innerHTML = '';

      if (meetingEntries.length === 0) {
        detailEl.innerHTML = '<div class="empty-state">No transcription entries</div>';
        footerLeft.textContent = '0 entries';
        footerRight.textContent = '';
        return;
      }

      // Entries
      const entriesContainer = document.createElement('div');
      entriesContainer.className = 'detail-entries';
      for (const entry of meetingEntries) {
        entriesContainer.appendChild(renderEntry(entry));
      }
      detailEl.appendChild(entriesContainer);

      footerLeft.textContent = `${meetingEntries.length} entries`;
      footerRight.textContent = '';
    } catch {
      detailEl.innerHTML = '<div class="empty-state">Failed to load meeting</div>';
    }
  }

  // --- Communication with service worker ---

  function connectPort(): void {
    if (port) return;
    try {
      port = chrome.runtime.connect(undefined, { name: POPUP_PORT_NAME });

      port.onMessage.addListener((message) => {
        switch (message.type) {
          case 'meeting_snapshot':
            currentMeeting = message.meeting;
            entries = message.entries ?? [];
            if (currentMeeting) {
              participantCount = new Set(Object.values(currentMeeting.participants || {})).size;
              if (currentView === 'live') {
                popupTitle.textContent = currentMeeting.title;
              }
            }
            renderAllEntries();
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
            if (currentView === 'live') {
              popupTitle.textContent = currentMeeting?.title ?? 'Live';
            }
            break;

          case 'meeting_ended':
            currentMeeting = null;
            participantCount = 0;
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
              participantCount = new Set(Object.values(currentMeeting.participants)).size;
              updateFooter();
            }
            break;
        }
      });

      port.onDisconnect.addListener(() => {
        port = null;
        setTimeout(connectPort, 2000);
      });
    } catch {
      setTimeout(connectPort, 5000);
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
        host.style.bottom = '80px';
      }

      const size = result[STORAGE_SIZE_KEY];
      if (size && typeof size === 'object') {
        popupWidth = size.width ?? DEFAULT_WIDTH;
        popupHeight = size.height ?? DEFAULT_HEIGHT;
      }
      applySize();
    } catch {
      host.style.right = '20px';
      host.style.bottom = '80px';
      applySize();
    }
  }

  function savePosition(): void {
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

      .popup {
        width: ${DEFAULT_WIDTH}px;
        height: ${DEFAULT_HEIGHT}px;
        background: rgba(32, 33, 36, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        color: #e8eaed;
        font-family: 'Google Sans', Roboto, Arial, sans-serif;
        font-size: 13px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        position: relative;
      }

      .popup.minimized {
        height: auto !important;
        width: auto !important;
        min-width: 160px;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.05);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        min-height: 40px;
        flex-shrink: 0;
      }

      .drag-handle {
        cursor: grab;
        flex: 1;
        user-select: none;
        overflow: hidden;
      }

      .drag-handle:active {
        cursor: grabbing;
      }

      .title {
        font-weight: 500;
        font-size: 13px;
        letter-spacing: 0.3px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: block;
        outline: none;
        border-radius: 3px;
        padding: 1px 3px;
        margin: -1px -3px;
      }

      .title-prefix {
        opacity: 0.5;
      }
      .title-sep {
        opacity: 0.3;
      }
      .title-page {
        outline: none;
        border-radius: 3px;
        padding: 1px 3px;
        margin: -1px -3px;
      }
      .title-page[contenteditable="true"] {
        background: rgba(255, 255, 255, 0.08);
        outline: 1px solid #8ab4f8;
        white-space: normal;
        cursor: text;
      }

      .autocomplete-list {
        position: absolute;
        background: #35363a;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        max-height: 120px;
        overflow-y: auto;
        z-index: 1000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      }
      .autocomplete-list:empty { display: none; }
      .autocomplete-item {
        padding: 5px 10px;
        font-size: 12px;
        color: #e8eaed;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .autocomplete-item:hover,
      .autocomplete-item.active {
        background: rgba(138, 180, 248, 0.15);
      }

      .header-actions {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
      }

      .btn-icon {
        background: none;
        border: none;
        color: #9aa0a6;
        cursor: pointer;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        transition: background 0.15s, color 0.15s;
      }

      .btn-icon:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #e8eaed;
      }

      .btn-icon.active {
        color: #8ab4f8;
      }

      .btn-icon svg {
        width: 14px;
        height: 14px;
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
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        flex-shrink: 0;
      }

      .lang-select {
        flex: 1;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        color: #e8eaed;
        padding: 4px 8px;
        font-size: 12px;
        cursor: pointer;
        outline: none;
      }

      .lang-select:focus {
        border-color: #8ab4f8;
      }

      .lang-select option {
        background: #303134;
        color: #e8eaed;
      }

      .btn-small {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        color: #8ab4f8;
        padding: 4px 10px;
        font-size: 12px;
        cursor: pointer;
        transition: background 0.15s;
        white-space: nowrap;
      }

      .btn-small:hover {
        background: rgba(138, 180, 248, 0.15);
      }

      .content-area {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .transcript,
      .meetings-view,
      .detail-view {
        flex: 1;
        overflow-y: auto;
        padding: 8px 12px;
        scroll-behavior: smooth;
      }

      .transcript::-webkit-scrollbar,
      .meetings-view::-webkit-scrollbar,
      .detail-view::-webkit-scrollbar {
        width: 4px;
      }

      .transcript::-webkit-scrollbar-track,
      .meetings-view::-webkit-scrollbar-track,
      .detail-view::-webkit-scrollbar-track {
        background: transparent;
      }

      .transcript::-webkit-scrollbar-thumb,
      .meetings-view::-webkit-scrollbar-thumb,
      .detail-view::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
        border-radius: 2px;
      }

      .entry {
        margin-bottom: 8px;
        padding: 6px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        animation: fadeIn 0.15s ease;
      }

      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .entry:last-child {
        border-bottom: none;
      }

      .speaker {
        font-weight: 600;
        color: #8ab4f8;
        font-size: 12px;
        margin-right: 6px;
      }

      .time {
        color: #9aa0a6;
        font-size: 11px;
      }

      .text {
        margin-top: 2px;
        line-height: 1.4;
        color: #dadce0;
        word-break: break-word;
      }

      .footer {
        display: flex;
        justify-content: space-between;
        padding: 6px 12px;
        font-size: 11px;
        color: #9aa0a6;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
        flex-shrink: 0;
      }

      /* Resize handle */
      .resize-handle {
        position: absolute;
        right: 0;
        bottom: 0;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
        z-index: 10;
      }

      .resize-handle::after {
        content: '';
        position: absolute;
        right: 4px;
        bottom: 4px;
        width: 8px;
        height: 8px;
        border-right: 2px solid rgba(255, 255, 255, 0.2);
        border-bottom: 2px solid rgba(255, 255, 255, 0.2);
        border-radius: 0 0 2px 0;
      }

      /* Meetings list */
      .meeting-item {
        padding: 10px;
        border-radius: 8px;
        cursor: pointer;
        transition: background 0.15s;
        margin-bottom: 4px;
      }

      .meeting-item:hover {
        background: rgba(255, 255, 255, 0.06);
      }

      .meeting-item.current {
        background: rgba(138, 180, 248, 0.08);
        border: 1px solid rgba(138, 180, 248, 0.2);
      }

      .meeting-item-header {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .meeting-item-title {
        font-weight: 500;
        color: #e8eaed;
        flex: 1;
        outline: none;
        border-radius: 3px;
        padding: 1px 3px;
        margin: -1px -3px;
      }

      .meeting-item-title[contenteditable="true"] {
        background: rgba(255, 255, 255, 0.08);
        outline: 1px solid #8ab4f8;
      }

      .live-badge {
        background: #c5221f;
        color: white;
        font-size: 9px;
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 3px;
        letter-spacing: 0.5px;
        flex-shrink: 0;
      }

      .meeting-item-meta {
        font-size: 11px;
        color: #9aa0a6;
        margin-top: 4px;
      }

      .back-nav {
        padding: 4px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        flex-shrink: 0;
      }

      .btn-back-live {
        background: none;
        border: none;
        color: #9aa0a6;
        font-size: 11px;
        cursor: pointer;
        padding: 2px 0;
        opacity: 0.7;
        transition: opacity 0.15s, color 0.15s;
      }

      .btn-back-live:hover {
        opacity: 1;
        color: #8ab4f8;
      }

      .meeting-item-participants {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
      }

      .participant-tag {
        background: rgba(138, 180, 248, 0.12);
        color: #8ab4f8;
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 8px;
        white-space: nowrap;
      }

      .meeting-item-actions {
        display: flex;
        gap: 4px;
        margin-left: auto;
        opacity: 0;
        transition: opacity 0.15s;
        flex-shrink: 0;
      }

      .meeting-item:hover .meeting-item-actions {
        opacity: 1;
      }

      .meeting-action {
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 4px;
        color: #9aa0a6;
        cursor: pointer;
        font-size: 12px;
        width: 24px;
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s, color 0.15s;
        padding: 0;
      }

      .meeting-action:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #e8eaed;
      }

      .meeting-action[data-action="delete"]:hover {
        background: rgba(234, 67, 53, 0.15);
        color: #f28b82;
      }

      .delete-confirm {
        font-size: 12px;
        color: #f28b82;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .confirm-yes,
      .confirm-no {
        background: none;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 4px;
        color: #9aa0a6;
        cursor: pointer;
        font-size: 11px;
        padding: 2px 8px;
        transition: background 0.15s, color 0.15s;
      }

      .confirm-yes:hover {
        background: rgba(234, 67, 53, 0.2);
        color: #f28b82;
        border-color: rgba(234, 67, 53, 0.3);
      }

      .confirm-no:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #e8eaed;
      }

      /* Detail view */
      .btn-back {
        background: none;
        border: none;
        color: #8ab4f8;
        font-size: 12px;
        cursor: pointer;
        padding: 6px 0;
        margin-bottom: 8px;
        display: block;
      }

      .btn-back:hover {
        text-decoration: underline;
      }

      .detail-entries {
        /* entries already styled */
      }

      .empty-state,
      .loading {
        text-align: center;
        color: #9aa0a6;
        padding: 40px 0;
        font-size: 13px;
      }
    `;
  }
})();
