import { MSG, type Meeting, type TranscriptEntry } from '../utils/types';

(function () {
  const contentEl = document.getElementById('content')!;
  const headerTitle = document.getElementById('header-title')!;
  const btnBack = document.getElementById('btn-back') as HTMLButtonElement;
  const footerEl = document.getElementById('footer')!;
  const footerLeft = document.getElementById('footer-left')!;
  let currentView: 'list' | 'detail' = 'list';
  let viewingMeetingId: string | null = null;

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
    headerTitle.textContent = 'MeetScribe';
    btnBack.style.display = 'none';
    footerEl.style.display = 'none';
    viewingMeetingId = null;
    loadMeetings();
  }

  function showDetail(meetingId: string, title: string): void {
    currentView = 'detail';
    viewingMeetingId = meetingId;
    headerTitle.textContent = title;
    btnBack.style.display = 'block';
    loadDetail(meetingId);
  }

  // --- Export from detail view ---

  // --- Meetings list ---

  async function loadMeetings(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({ type: MSG.GET_MEETINGS });
      const meetings = (response?.meetings ?? []) as Omit<Meeting, 'entries'>[];
      const liveMeetingId = response?.currentMeetingId as string | null;

      if (meetings.length === 0) {
        contentEl.innerHTML = '<div class="empty-state">No meetings yet</div>';
        return;
      }

      contentEl.innerHTML = '';
      for (const m of meetings) {
        contentEl.appendChild(createItem(m, m.id === liveMeetingId));
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
    const participants = [...new Set(Object.values(m.participants || {}))];

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
            const blob = new Blob([response.content], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const title = (response.title ?? m.title).replace(/[^a-zA-Z0-9 _-]/g, '').trim();
            const d = new Date(response.startTime ?? m.startTime);
            const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
            a.download = `${title} ${dateStr}.md`;
            a.click();
            URL.revokeObjectURL(url);
          }
        }).catch(() => {});
      }

      if (action === 'delete') {
        actionsEl.innerHTML = '<span class="delete-confirm">Delete? <button class="confirm-yes">Yes</button> <button class="confirm-no">No</button></span>';
        actionsEl.style.opacity = '1';

        actionsEl.querySelector('.confirm-yes')!.addEventListener('click', (ev) => {
          ev.stopPropagation();
          chrome.runtime.sendMessage({
            type: MSG.DELETE_MEETING,
            payload: { id: m.id },
          }).then((resp) => {
            if (resp && !resp.ok) { loadMeetings(); return; }
            item.remove();
            if (contentEl.children.length === 0) {
              contentEl.innerHTML = '<div class="empty-state">No meetings yet</div>';
            }
          }).catch(() => {});
        });

        actionsEl.querySelector('.confirm-no')!.addEventListener('click', (ev) => {
          ev.stopPropagation();
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
      if ((e.target as HTMLElement).getAttribute('contenteditable') === 'true') return;
      if ((e.target as HTMLElement).closest('.meeting-item-actions')) return;

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
      contentEl.innerHTML = '';

      if (entries.length === 0) {
        contentEl.innerHTML = '<div class="empty-state">No transcription entries</div>';
        footerEl.style.display = 'flex';
        footerLeft.textContent = '0 entries';
        return;
      }

      const container = document.createElement('div');
      container.className = 'detail-entries';
      for (const entry of entries) {
        container.appendChild(renderEntry(entry));
      }
      contentEl.appendChild(container);

      footerEl.style.display = 'flex';
      footerLeft.textContent = `${entries.length} entries`;
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

  loadMeetings();
})();
