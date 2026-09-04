import { MSG, POPUP_PORT_NAME, type Meeting, type TranscriptEntry, type NoteEntry } from '../utils/types';
import type { PairStage, Snapshot as NotulaSnapshot } from '../background/notula-sync';
import {
  AWAITING_POLL_MS,
  NOTULA_SITE,
  brainLink,
  defaultLine,
  renderConnect,
  renderOffers,
  renderScreen,
  liveLine,
  saveLine,
  stageAfter,
} from '../utils/notula-ui';
import type { NotulaContext, UiStage } from '../utils/notula-ui';

(function () {
  const contentEl = document.getElementById('content')!;
  const headerTitle = document.getElementById('header-title')!;
  const btnBack = document.getElementById('btn-back') as HTMLButtonElement;
  const footerEl = document.getElementById('footer')!;
  const footerLeft = document.getElementById('footer-left')!;
  const headerActions = document.getElementById('header-actions')!;
  const detailCopyBtn = document.getElementById('detail-copy') as HTMLButtonElement;
  const detailExportBtn = document.getElementById('detail-export') as HTMLButtonElement;
  let currentView: 'list' | 'detail' = 'list';
  let viewingMeetingId: string | null = null;
  let viewingMeetingTitle: string = '';

  // --- Notula ---

  const connectOffer = document.getElementById('connect-offer') as HTMLButtonElement;
  const connectWait = document.getElementById('connect-wait')!;
  const offersEl = document.getElementById('offers')!;
  const screenEl = document.getElementById('screen')!;
  const defaultEl = document.getElementById('default-line')!;
  let notulaSnapshot: NotulaSnapshot | null = null;
  let pairStage: UiStage = 'idle';
  let pairCode = '';
  let awaitingTimer: ReturnType<typeof setInterval> | null = null;
  let screenShown = false;

  // The same port the panel uses, for the same messages. The meeting traffic
  // on it is for the panel and is ignored here.
  const port = chrome.runtime.connect(undefined, { name: POPUP_PORT_NAME });
  const notulaCtx: NotulaContext = {
    snapshot: () => notulaSnapshot,
    send: (message) => {
      try {
        port.postMessage(message);
      } catch { /* service worker restarting */ }
    },
    container: document.body,
  };

  function startAwaiting(): void {
    if (awaitingTimer) return;
    awaitingTimer = setInterval(() => {
      const state = notulaSnapshot?.status.state ?? 'notPaired';
      notulaCtx.send({ type: state === 'notPaired' ? 'notula_pair_start' : 'notula_check' });
    }, AWAITING_POLL_MS);
  }

  function stopAwaiting(): void {
    if (awaitingTimer) clearInterval(awaitingTimer);
    awaitingTimer = null;
  }

  function leaveScreen(): void {
    if (pairStage === 'pairing') notulaCtx.send({ type: 'notula_pair_cancel' });
    pairStage = 'idle';
    stopAwaiting();
    renderNotula();
  }

  function renderNotula(): void {
    renderConnect(notulaCtx, connectOffer, connectWait, pairStage);
    renderOffers(notulaCtx, offersEl);
    defaultEl.innerHTML = '';
    const line = defaultLine(notulaCtx);
    if (line) defaultEl.appendChild(line);
    defaultEl.hidden = line === null;
    const show = renderScreen(notulaCtx, screenEl, pairStage, pairCode, {
      later: leaveScreen,
      get: () => {
        void chrome.tabs.create({ url: NOTULA_SITE });
        pairStage = 'awaiting';
        startAwaiting();
        renderNotula();
      },
      awaiting: startAwaiting,
    });
    const listing = currentView === 'list';
    if (show) {
      for (const view of [contentEl, footerEl, offersEl, defaultEl]) view.style.display = 'none';
      screenShown = true;
    } else if (screenShown) {
      screenShown = false;
      if (pairStage === 'idle' && notulaSnapshot?.status.state !== 'noWorkspace') stopAwaiting();
      contentEl.style.display = '';
      offersEl.style.display = listing ? '' : 'none';
      defaultEl.style.display = listing ? '' : 'none';
      footerEl.style.display = 'flex';
      if (listing) footerLeft.innerHTML = brainLink();
    }
    if (listing && !show) void loadMeetings();
  }

  port.onMessage.addListener((message: { type?: string } & Record<string, unknown>) => {
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
          if (message.save) notulaSnapshot.saves[String(message.meetingId)] = message.save as NotulaSnapshot['saves'][string];
          else delete notulaSnapshot.saves[String(message.meetingId)];
        }
        if (currentView === 'list') void loadMeetings();
        break;
      case 'notula_pair':
        pairStage = stageAfter(pairStage, message.stage as PairStage);
        if (pairStage === 'pairing') pairCode = String(message.code ?? '');
        if (pairStage !== 'awaiting') stopAwaiting();
        renderNotula();
        break;
      default:
        break;
    }
  });

  connectOffer.addEventListener('click', () => {
    connectOffer.disabled = true;
    notulaCtx.send({ type: 'notula_pair_start' });
    setTimeout(() => {
      connectOffer.disabled = false;
    }, 4000);
  });

  function escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Navigation ---

  btnBack.addEventListener('click', () => {
    showList();
  });

  function showList(): void {
    currentView = 'list';
    headerTitle.textContent = 'Notula for Google Meet';
    btnBack.style.display = 'none';
    headerActions.style.display = 'none';
    footerEl.style.display = 'flex';
    footerLeft.innerHTML = brainLink();
    offersEl.style.display = '';
    defaultEl.style.display = '';
    viewingMeetingId = null;
    viewingMeetingTitle = '';
    loadMeetings();
  }

  function showDetail(meetingId: string, title: string): void {
    currentView = 'detail';
    viewingMeetingId = meetingId;
    viewingMeetingTitle = title;
    headerTitle.textContent = title;
    btnBack.style.display = 'block';
    headerActions.style.display = 'flex';
    offersEl.style.display = 'none';
    defaultEl.style.display = 'none';
    loadDetail(meetingId);
  }

  // --- Detail header actions ---

  detailCopyBtn.addEventListener('click', () => {
    if (!viewingMeetingId) return;
    chrome.runtime.sendMessage({
      type: MSG.EXPORT_MEETING,
      payload: { id: viewingMeetingId, format: 'md' },
    }).then(async (response) => {
      if (response?.content) {
        try {
          await navigator.clipboard.writeText(response.content);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = response.content;
          ta.style.cssText = 'position:fixed;left:-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        const orig = detailCopyBtn.textContent;
        detailCopyBtn.textContent = '\u2713';
        detailCopyBtn.title = 'Copied!';
        setTimeout(() => {
          detailCopyBtn.textContent = orig;
          detailCopyBtn.title = 'Copy as Markdown';
        }, 1500);
      }
    }).catch(() => {});
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

  detailExportBtn.addEventListener('click', () => {
    if (!viewingMeetingId) return;
    chrome.runtime.sendMessage({
      type: MSG.EXPORT_MEETING,
      payload: { id: viewingMeetingId, format: 'md' },
    }).then((response) => {
      if (response?.content) {
        download(response.content, response.title ?? viewingMeetingTitle, response.startTime ?? Date.now());
      }
    }).catch(() => {});
  });

  // --- Meetings list ---

  async function loadMeetings(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({ type: MSG.GET_MEETINGS });
      const meetings = (response?.meetings ?? []) as Omit<Meeting, 'entries'>[];
      const liveMeetingIds = (response?.liveMeetingIds ?? []) as string[];

      if (meetings.length === 0) {
        contentEl.innerHTML = '<div class="empty-state">No meetings yet</div>';
        return;
      }

      contentEl.innerHTML = '';
      for (const m of meetings) {
        contentEl.appendChild(createItem(m, liveMeetingIds.includes(m.id)));
      }
    } catch {
      contentEl.innerHTML = '<div class="empty-state">Failed to load meetings</div>';
    }
  }

  function createItem(m: Omit<Meeting, 'entries'>, isLive: boolean): HTMLElement {
    const item = document.createElement('div');
    item.className = 'meeting-item' + (isLive ? ' current' : '');

    const date = new Date(m.startTime).toLocaleDateString();
    const time = new Date(m.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const participants = [...new Set(Object.values(m.participants || {}))]
      .filter(p => p !== m.meetingCode && !p.startsWith('@'));

    let durationStr: string;
    if (isLive) {
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

    // Under the name: where the call went, or where it will go while it is still on.
    const line = isLive ? liveLine(notulaCtx, m) : saveLine(notulaCtx, m);
    if (line) item.appendChild(line);

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
      }

      if (action === 'copy') {
        chrome.runtime.sendMessage({
          type: MSG.EXPORT_MEETING,
          payload: { id: m.id, format: 'md' },
        }).then(async (response) => {
          if (response?.content) {
            try {
              await navigator.clipboard.writeText(response.content);
            } catch {
              const ta = document.createElement('textarea');
              ta.value = response.content;
              ta.style.cssText = 'position:fixed;left:-9999px';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
            }
            const orig = btn.textContent;
            btn.textContent = '\u2713';
            btn.title = 'Copied!';
            setTimeout(() => {
              btn.textContent = orig;
              btn.title = 'Copy as Markdown';
            }, 1500);
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
            if (contentEl.children.length === 0) {
              contentEl.innerHTML = '<div class="empty-state">No meetings yet</div>';
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
      if ((e.target as HTMLElement).getAttribute('contenteditable') === 'true') return;
      if ((e.target as HTMLElement).closest('.meeting-item-actions')) return;
      if ((e.target as HTMLElement).closest('.where')) return;

      if (isLive) {
        // Focus the Meet tab
        chrome.tabs.query({ url: 'https://meet.google.com/*' }).then((tabs) => {
          const meetTab = tabs.find(t => t.url?.includes(m.meetingCode));
          if (meetTab?.id) {
            chrome.tabs.update(meetTab.id, { active: true });
            window.close();
          } else {
            showDetail(m.id, m.title);
          }
        });
        return;
      }

      showDetail(m.id, m.title);
    });

    // Double-click title to rename
    titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      titleEl.contentEditable = 'true';
      titleEl.focus();
      const range = document.createRange();
      range.selectNodeContents(titleEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    titleEl.addEventListener('blur', () => {
      titleEl.contentEditable = 'false';
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

  // --- Detail view ---

  async function loadDetail(meetingId: string): Promise<void> {
    contentEl.innerHTML = '<div class="loading">Loading...</div>';

    try {
      const response = await chrome.runtime.sendMessage({
        type: MSG.GET_MEETING_ENTRIES,
        meetingId,
      });
      const entries = (response?.entries ?? []) as TranscriptEntry[];
      const meetingNotes = (response?.notes ?? []) as NoteEntry[];
      contentEl.innerHTML = '';

      if (entries.length === 0 && meetingNotes.length === 0) {
        contentEl.innerHTML = '<div class="empty-state">No transcription entries</div>';
        footerEl.style.display = 'flex';
        footerLeft.textContent = '0 lines';
        return;
      }

      // Notes section
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
        contentEl.appendChild(notesSection);
      }

      const container = document.createElement('div');
      container.className = 'detail-entries';
      for (const entry of entries) {
        container.appendChild(renderEntry(entry));
      }
      contentEl.appendChild(container);

      footerEl.style.display = 'flex';
      footerLeft.textContent = `${entries.length} line${entries.length === 1 ? '' : 's'}${meetingNotes.length > 0 ? ` \u00b7 ${meetingNotes.length} note${meetingNotes.length === 1 ? '' : 's'}` : ''}`;
    } catch {
      contentEl.innerHTML = '<div class="empty-state">Failed to load meeting</div>';
    }
  }

  function renderEntry(entry: TranscriptEntry): HTMLElement {
    const div = document.createElement('div');
    div.className = 'entry';
    const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
      <span class="speaker">${escapeHtml(entry.speaker)}</span>
      <span class="time">${time}</span>
      <div class="text">${escapeHtml(entry.text)}</div>
    `;
    return div;
  }

  // --- Init ---

  // Through showList rather than straight to loadMeetings: the list state is
  // set in one place, and the footer is part of it.
  showList();
})();
