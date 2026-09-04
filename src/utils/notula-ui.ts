import type { Meeting } from './types';
import type { Destination, MeetingSave } from './notula-state';
import { DEFAULT_FOLDER } from './notula-state';
import type { WorkspaceInfo } from './notula';
import type { PairStage, Snapshot } from '../background/notula-sync';

/**
 * What the panel in Meet and the toolbar popup both draw about Notula: the
 * line under a meeting saying where it went, the destination picker, the
 * connect line, the four screens and the two one-time cards. One copy, so the
 * two surfaces cannot say different things about the same meeting.
 *
 * Everything is a function of a context: how to read the latest snapshot, how
 * to send a message to the service worker, and which element menus hang from.
 */

export const NOTULA_SITE = 'https://notula.org';
/** How long Undo stays on a card after a save. */
export const UNDO_WINDOW_MS = 60_000;
/** The waiting screens ask again this often; nothing else ever polls. */
export const AWAITING_POLL_MS = 5000;

export const FOLDER_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>';
export const LINK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 9.4l2.8-2.8M6.2 4.6 7.6 3.2a2.7 2.7 0 0 1 3.82 3.82L10 8.44M10 11.4 8.6 12.8a2.7 2.7 0 0 1-3.82-3.82L6.2 7.56"/></svg>';
const REPO_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 9.5h5"/></svg>';
const CHEVRON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';

export type UiStage = 'idle' | 'explaining' | 'awaiting' | 'pairing';

export interface NotulaContext {
  snapshot(): Snapshot | null;
  send(message: Record<string, unknown>): void;
  /** Menus are positioned inside this; it has to be `position: relative`. */
  container: HTMLElement;
}

export function el(html: string): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild as HTMLElement;
}

export const connected = (ctx: NotulaContext): boolean => ctx.snapshot()?.status.state === 'paired';

const basename = (root: string): string => root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? root;

export function workspaceName(snapshot: Snapshot | null, root: string): string {
  return snapshot?.workspaces.find(one => one.root === root)?.name ?? basename(root);
}

/**
 * The same rule the service worker applies, so the footer predicts what will
 * happen: the memory for this call, else the default, else the only repository
 * Notula knows. With several repositories and no default there is no answer,
 * and the line asks.
 */
export function destinationFor(snapshot: Snapshot | null, code: string): Destination | null {
  const memory = snapshot?.memory;
  const own = code ? memory?.byCode[code] : undefined;
  if (own) return own;
  if (memory?.default) return memory.default;
  const only = snapshot?.workspaces.length === 1 ? snapshot.workspaces[0] : undefined;
  return only ? { workspace: only.root, folder: DEFAULT_FOLDER } : null;
}

/** `folio · meetings/`: the repository, then the folder in it. */
export function destLabel(snapshot: Snapshot | null, dest: Destination): string {
  return `${workspaceName(snapshot, dest.workspace)} · ${dest.folder}/`;
}

/**
 * A typed folder as the server will take it, or null when it is not a folder
 * name at all: empty, escaping upwards, hidden, or carrying characters no file
 * system agrees on.
 */
export function cleanFolder(text: string): string | null {
  const parts = text.trim().replace(/\\/g, '/').split('/').filter(seg => seg !== '' && seg !== '.');
  if (parts.length === 0) return null;
  if (parts.some(seg => seg === '..' || seg.startsWith('.') || /[:*?"<>|]/.test(seg))) return null;
  return parts.join('/');
}

/** The next screen after the service worker said where pairing got to. */
export function stageAfter(current: UiStage, stage: PairStage): UiStage {
  if (stage === 'explaining') return current === 'awaiting' ? 'awaiting' : 'explaining';
  if (stage === 'pairing') return 'pairing';
  return 'idle';
}

/**
 * One line: an icon, what happened, the destination as a button when there is
 * one, and the actions on the right. The same element on a card and in the
 * footer, so the two never drift apart.
 */
export function whereLine(
  ctx: NotulaContext,
  opts: {
    text: string;
    /** Where it goes; null is a destination still to be chosen, undefined is no chip at all. */
    dest?: Destination | null;
    code?: string;
    meetingId?: string;
    tone?: 'warning' | 'danger';
    acts?: Array<[string, (button: HTMLElement) => void]>;
    /** What a pick from the menu does instead of remembering it for the call. */
    pick?: (dest: Destination) => void;
    /** Offered in the picker as the way to have no default at all. */
    clear?: () => void;
  },
): HTMLElement {
  const line = el(`<span class="where${opts.tone ? ` ${opts.tone}` : ''}${opts.dest !== undefined ? ' with-dest' : ''}">${opts.tone ? '' : FOLDER_ICON}<span class="what"></span></span>`);
  line.querySelector('.what')!.textContent = opts.text;
  if (opts.dest !== undefined) {
    const dest = opts.dest;
    const button = dest
      ? el('<button type="button" class="dest"><span class="repo"></span><span class="sep">·</span><span class="folder"></span></button>')
      : el('<button type="button" class="dest empty">Choose where…</button>');
    if (dest) {
      button.title = destLabel(ctx.snapshot(), dest);
      button.querySelector('.repo')!.textContent = workspaceName(ctx.snapshot(), dest.workspace);
      button.querySelector('.folder')!.textContent = `${dest.folder}/`;
    }
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      openDestMenu(ctx, button, dest, { code: opts.code ?? '', meetingId: opts.meetingId, pick: opts.pick, clear: opts.clear });
    });
    line.appendChild(button);
  }
  if (opts.acts && opts.acts.length > 0) {
    const acts = el('<span class="acts"></span>');
    for (const [label, run] of opts.acts) {
      const button = el('<button type="button"></button>');
      button.textContent = label;
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        run(button);
      });
      acts.appendChild(button);
    }
    line.appendChild(acts);
  }
  return line;
}

/**
 * The card line for a meeting that has ended. Every finished meeting has one
 * once there is a connection: where it went, or where it would go and the
 * button that sends it. Before pairing there is nothing to say, and the
 * connect line under the header is what there is to press.
 */
export function saveLine(ctx: NotulaContext, m: Omit<Meeting, 'entries'>): HTMLElement | null {
  const snapshot = ctx.snapshot();
  const save: MeetingSave | undefined = snapshot?.saves[m.id];
  if (!save && (snapshot?.status.state ?? 'notPaired') === 'notPaired') return null;
  const again = (): void => ctx.send({ type: 'notula_save', meetingId: m.id });
  const dest: Destination | null = save?.workspace ? { workspace: save.workspace, folder: save.folder } : destinationFor(snapshot, m.meetingCode);
  const code = m.meetingCode;
  const meetingId = m.id;
  switch (save?.state) {
    case 'saving':
      return whereLine(ctx, { text: 'Saving…' });
    case 'saved': {
      if (save.gone) {
        return whereLine(ctx, { text: 'This document is no longer in Notula', tone: 'warning', acts: [['Save again', again]] });
      }
      const acts: Array<[string, () => void]> = [['Open', () => ctx.send({ type: 'notula_open', meetingId })]];
      if (save.savedAt !== undefined && Date.now() - save.savedAt < UNDO_WINDOW_MS) {
        acts.push(['Undo', () => ctx.send({ type: 'notula_undo', meetingId })]);
      }
      return whereLine(ctx, { text: 'Saved to', dest, code, meetingId, acts });
    }
    case 'queued':
      return whereLine(ctx, { text: 'Waiting for Notula', tone: 'warning', dest, code, meetingId });
    case 'failed':
      return whereLine(ctx, { text: 'Could not save', tone: 'danger', dest, code, meetingId, acts: [['Try again', again]] });
    default:
      // With nowhere chosen, Save asks where first and the pick saves at once.
      return whereLine(ctx, {
        text: 'Not saved',
        dest,
        code,
        meetingId,
        acts: [['Save to Notula', (button) => {
          if (dest) again();
          else openDestMenu(ctx, button, null, { code, meetingId, pick: (chosen) => ctx.send({ type: 'notula_save', meetingId, workspace: chosen.workspace, folder: chosen.folder }) });
        }]],
      });
  }
}

/**
 * The line for a meeting still going: where it will land when it ends, or
 * where the part saved so far went. Save now writes what there is, and the end
 * of the call writes the rest over it.
 */
export function liveLine(ctx: NotulaContext, m: Omit<Meeting, 'entries'>): HTMLElement | null {
  const snapshot = ctx.snapshot();
  const save: MeetingSave | undefined = snapshot?.saves[m.id];
  if (!save && (snapshot?.status.state ?? 'notPaired') === 'notPaired') return null;
  const dest: Destination | null = save?.workspace ? { workspace: save.workspace, folder: save.folder } : destinationFor(snapshot, m.meetingCode);
  const code = m.meetingCode;
  const meetingId = m.id;
  const now = (button: HTMLElement): void => {
    if (dest) ctx.send({ type: 'notula_save', meetingId });
    else openDestMenu(ctx, button, null, { code, meetingId, pick: (chosen) => ctx.send({ type: 'notula_save', meetingId, workspace: chosen.workspace, folder: chosen.folder }) });
  };
  if (save?.state === 'saving') return whereLine(ctx, { text: 'Saving…' });
  if (save?.state === 'saved' && !save.gone) {
    return whereLine(ctx, { text: 'Saved to', dest, code, meetingId, acts: [['Open', () => ctx.send({ type: 'notula_open', meetingId })], ['Save now', now]] });
  }
  return whereLine(ctx, { text: 'Will be saved to', dest, code, meetingId, acts: [['Save now', now]] });
}

let menu: HTMLElement | null = null;
let menuAnchor: HTMLElement | null = null;
/** The tree the picker is in: the document, or the panel's closed shadow root. */
let menuRoot: Node | null = null;

/** Takes the picker down. `restore` gives focus back to the button it opened from. */
export function closeDestMenu(restore = false): void {
  const anchor = menuAnchor;
  menu?.remove();
  menu = null;
  menuAnchor = null;
  menuRoot?.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('mousedown', onOutsideHost, true);
  menuRoot = null;
  document.removeEventListener('keydown', onKey, true);
  if (restore) anchor?.focus();
}

/**
 * A press anywhere but the picker closes it. Listened for on the picker's own
 * tree: from outside a closed shadow root the path stops at the host, and every
 * press inside the panel looked like a press outside the picker.
 */
function onOutside(e: Event): void {
  if (menu && !e.composedPath().includes(menu)) closeDestMenu();
}

/** The page around the panel, where the path cannot say more than which host was pressed. */
function onOutsideHost(e: Event): void {
  const host = menuRoot instanceof ShadowRoot ? menuRoot.host : null;
  if (menu && host && !e.composedPath().includes(host)) closeDestMenu();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeDestMenu(true);
  }
}

interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
}

/** Folder paths as a tree, siblings in name order. */
function folderTree(paths: Iterable<string>): FolderNode[] {
  const root: FolderNode = { name: '', path: '', children: [] };
  for (const path of paths) {
    let node = root;
    let sofar = '';
    for (const seg of path.split('/')) {
      sofar = sofar ? `${sofar}/${seg}` : seg;
      let next = node.children.find(child => child.name === seg);
      if (!next) {
        next = { name: seg, path: sofar, children: [] };
        node.children.push(next);
      }
      node = next;
    }
  }
  const order = (nodes: FolderNode[]): void => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const node of nodes) order(node.children);
  };
  order(root.children);
  return root.children;
}

/**
 * The destination picker: the repository across the top, which opens into
 * every repository Notula knows; under it the repository's folders as a tree,
 * top level first and the rest behind chevrons; and a field that filters the
 * folders or names one that does not exist yet, which is made on the first
 * write. Picking is remembered for this call; the last line makes the current
 * destination the default for calls that have no memory of their own.
 */
export function openDestMenu(
  ctx: NotulaContext,
  anchor: HTMLElement,
  current: Destination | null,
  opts: { code: string; meetingId?: string; pick?: (dest: Destination) => void; clear?: () => void },
): void {
  if (menu) {
    closeDestMenu();
    return;
  }
  const snapshot = ctx.snapshot();
  const workspaces: WorkspaceInfo[] = [...(snapshot?.workspaces ?? [])];
  if (current && !workspaces.some(one => one.root === current.workspace)) {
    workspaces.push({ root: current.workspace, name: basename(current.workspace) });
  }
  const box = el('<div class="menu picker" role="dialog"></div>');

  if (workspaces.length === 0) {
    box.appendChild(el('<div class="item plain">Open a folder in Notula first.</div>'));
    show(ctx, anchor, box);
    return;
  }

  let workspace = current?.workspace ?? workspaces[0].root;
  let listing = false;
  let cursor = 0;
  const expanded = new Set<string>();
  const openTo = (folder: string): void => {
    const parts = folder.split('/');
    for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join('/'));
  };
  if (current && workspace === current.workspace) openTo(current.folder);

  const head = el(`<button type="button" class="head" title="Change repository">${REPO_ICON}<span class="name"></span>${CHEVRON}</button>`);
  const filter = el('<input class="filter" type="text" placeholder="Find or create a folder…" spellcheck="false" autocomplete="off">') as HTMLInputElement;
  const body = el('<div class="body" role="listbox"></div>');
  const foot = el('<button type="button" class="item plain foot"><span></span></button>');
  box.append(head, filter, body, foot);

  const fallback = snapshot?.memory.default;
  const isDefault = current !== null && fallback !== undefined && fallback.workspace === current.workspace && fallback.folder === current.folder;
  if (opts.clear) {
    const clear = opts.clear;
    foot.hidden = fallback === undefined;
    foot.querySelector('span')!.textContent = 'Choose for each meeting instead';
    foot.addEventListener('click', () => {
      closeDestMenu(true);
      clear();
    });
  } else {
    foot.hidden = current === null || isDefault || opts.pick !== undefined;
    if (current) foot.querySelector('span')!.textContent = `Use ${destLabel(snapshot, current)} for new meetings`;
    foot.addEventListener('click', () => {
      closeDestMenu(true);
      if (current) ctx.send({ type: 'notula_default', workspace: current.workspace, folder: current.folder });
    });
  }

  const choose = (dest: Destination): void => {
    closeDestMenu(true);
    if (current && dest.workspace === current.workspace && dest.folder === current.folder) return;
    if (opts.pick) opts.pick(dest);
    else ctx.send({ type: 'notula_destination', code: opts.code, workspace: dest.workspace, folder: dest.folder, meetingId: opts.meetingId });
  };

  const rows = (): HTMLElement[] => [...body.querySelectorAll<HTMLElement>('button.item')];
  const mark = (): void => {
    const all = rows();
    all.forEach((row, i) => row.classList.toggle('cursor', i === cursor));
    all[cursor]?.scrollIntoView({ block: 'nearest' });
  };

  const repoRow = (one: WorkspaceInfo): HTMLElement => {
    const item = el(`<button type="button" class="item row${one.root === workspace ? ' on' : ''}" role="option">${REPO_ICON}<span class="name"></span></button>`);
    item.querySelector('.name')!.textContent = one.name;
    item.title = one.root;
    item.addEventListener('click', () => {
      workspace = one.root;
      listing = false;
      expanded.clear();
      if (current && workspace === current.workspace) openTo(current.folder);
      filter.value = '';
      render();
      filter.focus();
    });
    return item;
  };

  const folderRows = (): HTMLElement[] => {
    const known = new Set(snapshot?.folders[workspace] ?? []);
    const all = new Set<string>([...known, DEFAULT_FOLDER]);
    for (const one of Object.values(snapshot?.memory.byCode ?? {})) if (one.workspace === workspace) all.add(one.folder);
    if (snapshot?.memory.default?.workspace === workspace) all.add(snapshot.memory.default.folder);
    if (current && current.workspace === workspace) all.add(current.folder);
    all.delete('');
    const isOn = (folder: string): boolean => current !== null && workspace === current.workspace && folder === current.folder;
    const tag = (folder: string): string => (known.has(folder) ? '' : '<span class="tag">new</span>');

    const typed = filter.value.trim();
    if (typed === '') {
      const out: HTMLElement[] = [];
      const walk = (nodes: FolderNode[], depth: number): void => {
        for (const node of nodes) {
          const open = expanded.has(node.path);
          const branch = node.children.length > 0;
          const item = el(`<button type="button" class="item row${isOn(node.path) ? ' on' : ''}" role="option" style="--depth:${depth}"><span class="chev${branch ? (open ? ' open' : '') : ' none'}">${CHEVRON}</span>${FOLDER_ICON}<span class="name"></span>${tag(node.path)}</button>`);
          item.querySelector('.name')!.textContent = node.name;
          item.dataset.path = node.path;
          item.querySelector('.chev')!.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!branch) return;
            if (open) expanded.delete(node.path);
            else expanded.add(node.path);
            render(node.path);
          });
          item.addEventListener('click', () => choose({ workspace, folder: node.path }));
          out.push(item);
          if (open) walk(node.children, depth + 1);
        }
      };
      walk(folderTree(all), 0);
      return out;
    }

    const needle = typed.toLowerCase().replace(/\/+$/, '');
    const out: HTMLElement[] = [...all].filter(folder => folder.toLowerCase().includes(needle)).sort().map(folder => {
      const item = el(`<button type="button" class="item row${isOn(folder) ? ' on' : ''}" role="option">${FOLDER_ICON}<span class="name"></span>${tag(folder)}</button>`);
      item.querySelector('.name')!.textContent = `${folder}/`;
      item.addEventListener('click', () => choose({ workspace, folder }));
      return item;
    });
    const fresh = cleanFolder(typed);
    if (fresh && ![...all].some(folder => folder.toLowerCase() === fresh.toLowerCase())) {
      const item = el(`<button type="button" class="item row create" role="option">${FOLDER_ICON}<span class="name">Create <b></b></span></button>`);
      item.querySelector('b')!.textContent = `${fresh}/`;
      item.addEventListener('click', () => choose({ workspace, folder: fresh }));
      out.push(item);
    }
    if (out.length === 0) out.push(el('<div class="item plain">That is not a folder name.</div>'));
    return out;
  };

  const render = (keep?: string): void => {
    head.querySelector('.name')!.textContent = workspaceName(snapshot, workspace);
    head.classList.toggle('open', listing);
    filter.hidden = listing;
    body.innerHTML = '';
    for (const row of listing ? workspaces.map(repoRow) : folderRows()) body.appendChild(row);
    const all = rows();
    const kept = keep === undefined ? -1 : all.findIndex(row => row.dataset.path === keep);
    const on = all.findIndex(row => row.classList.contains('on'));
    cursor = Math.max(0, kept >= 0 ? kept : on);
    mark();
  };

  head.addEventListener('click', () => {
    listing = !listing;
    render();
    if (listing) ((body.querySelector('.on') as HTMLElement | null) ?? rows()[0])?.focus();
    else filter.focus();
  });
  filter.addEventListener('input', () => render());
  body.addEventListener('focusin', (e) => {
    const at = rows().indexOf(e.target as HTMLElement);
    if (at >= 0) {
      cursor = at;
      mark();
    }
  });
  box.addEventListener('keydown', (e) => {
    const all = rows();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (all.length === 0) return;
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
      mark();
      if (e.target !== filter) all[cursor].focus();
    } else if (e.key === 'Enter' && e.target === filter) {
      e.preventDefault();
      all[cursor]?.click();
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !listing && filter.value.trim() === '') {
      const path = all[cursor]?.dataset.path;
      if (path === undefined) return;
      e.preventDefault();
      if (e.key === 'ArrowRight') expanded.add(path);
      else expanded.delete(path);
      render(path);
    }
  });

  render();
  show(ctx, anchor, box);
  filter.focus();
}

/** Puts the picker across the surface, under the button when it fits and above it otherwise. */
function show(ctx: NotulaContext, anchor: HTMLElement, box: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const frame = ctx.container.getBoundingClientRect();
  const height = Math.min(320, frame.height - 16);
  box.style.maxHeight = `${height}px`;
  const below = rect.bottom - frame.top + 4;
  const above = rect.top - frame.top - 4;
  if (below + height <= frame.height - 8) box.style.top = `${below}px`;
  else if (above - height >= 8) box.style.bottom = `${frame.height - above}px`;
  else box.style.top = `${Math.max(8, frame.height - 8 - height)}px`;
  ctx.container.appendChild(box);
  menu = box;
  menuAnchor = anchor;
  menuRoot = ctx.container.getRootNode();
  menuRoot.addEventListener('mousedown', onOutside, true);
  if (menuRoot !== document) document.addEventListener('mousedown', onOutsideHost, true);
  document.addEventListener('keydown', onKey, true);
}

/** The line under the header: an offer, a wait, or nothing while everything is fine. */
export function renderConnect(ctx: NotulaContext, offer: HTMLElement, wait: HTMLElement, stage: UiStage): void {
  const state = ctx.snapshot()?.status.state ?? 'notPaired';
  offer.hidden = !(state === 'notPaired' && stage === 'idle');
  wait.hidden = state !== 'appClosed';
}

/**
 * The four full-surface screens, or none. Each has one way out. Returns
 * whether a screen is up, so the caller can take the rest of the surface away.
 */
export function renderScreen(
  ctx: NotulaContext,
  target: HTMLElement,
  stage: UiStage,
  code: string,
  on: { later(): void; get(): void; awaiting(): void },
): boolean {
  const state = ctx.snapshot()?.status.state ?? 'notPaired';
  let html = '';
  if (stage === 'explaining') {
    html = `<h3>Save meetings to your Git repo</h3>
      <p>Notula is a desktop app. It writes each finished call into a Markdown file in your repository - on your disk, no account, no server. This extension keeps working without it.</p>
      <p><a class="why" href="${NOTULA_SITE}/ai-brain" target="_blank" rel="noopener">Why the repository is the brain</a></p>
      <div class="actions"><button type="button" class="ghost" data-act="later">Not now</button><button type="button" class="primary" data-act="get">Get Notula</button></div>`;
  } else if (stage === 'awaiting') {
    html = `<h3>Waiting for Notula</h3>
      <ol class="steps"><li>Install Notula and open it.</li><li>Open your repository in it.</li><li>Nothing else - this connects by itself.</li></ol>
      <div class="actions"><button type="button" class="ghost" data-act="later">Not now</button></div>`;
  } else if (stage === 'pairing') {
    html = `<b class="code"></b>
      <p>Confirm in Notula that this code matches.</p>
      <div class="actions"><button type="button" class="ghost" data-act="later">Not now</button></div>`;
  } else if (state === 'noWorkspace') {
    html = `<h3>Open your repository in Notula</h3>
      <p>Notula saves into a folder on your disk. A git repository is the point of it, but any folder works.</p>`;
    on.awaiting();
  }
  const show = html !== '';
  target.classList.toggle('centre', stage === 'pairing');
  target.hidden = !show;
  if (show) {
    target.innerHTML = html;
    const shown = target.querySelector('.code');
    if (shown) shown.textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
    target.querySelector('[data-act="later"]')?.addEventListener('click', on.later);
    target.querySelector('[data-act="get"]')?.addEventListener('click', on.get);
  }
  return show;
}

/** The cards that show once: the rename, and the past meetings the first pairing found. */
export function renderOffers(ctx: NotulaContext, target: HTMLElement): void {
  target.innerHTML = '';
  const snapshot = ctx.snapshot();
  if (!snapshot) return;
  if (snapshot.notices.renamed === 'unseen') {
    const card = el(`<div class="offer"><div class="head"><span class="what">MeetScribe is now Notula</span><button type="button" class="dismiss" title="Dismiss">&#215;</button></div>
      <p>Every meeting you had is still here. New: a finished call can save itself into a Markdown file in a folder on your disk.</p></div>`);
    card.querySelector('.dismiss')!.addEventListener('click', () => ctx.send({ type: 'notula_dismiss', which: 'renamed' }));
    target.appendChild(card);
  }
  if (snapshot.backfill > 0 && snapshot.status.state === 'paired') {
    const n = snapshot.backfill;
    const dest = destinationFor(snapshot, '');
    const card = el(`<div class="offer"><div class="head"><span class="what"></span></div>
      <div class="actions"><button type="button" class="ghost" data-act="later">Not now</button><button type="button" class="primary" data-act="all">${dest ? 'Save all' : 'Choose where…'}</button></div></div>`);
    card.querySelector('.what')!.textContent = `${n} past meeting${n === 1 ? '' : 's'} can be saved to Notula`;
    card.querySelector('[data-act="later"]')!.addEventListener('click', () => ctx.send({ type: 'notula_dismiss', which: 'backfill' }));
    const all = card.querySelector('[data-act="all"]') as HTMLElement;
    all.addEventListener('click', () => {
      if (dest) ctx.send({ type: 'notula_save_all' });
      else openDestMenu(ctx, all, null, { code: '', pick: (chosen) => ctx.send({ type: 'notula_save_all', workspace: chosen.workspace, folder: chosen.folder }) });
    });
    target.appendChild(card);
  }
}

/**
 * The popup's one setting: where new meetings go, as a line with the
 * destination button on it. Only while connected; before that the connect
 * line is what there is to press. A default that was set can be taken away
 * again from the picker, after which every call is asked.
 */
export function defaultLine(ctx: NotulaContext): HTMLElement | null {
  if (!connected(ctx)) return null;
  const snapshot = ctx.snapshot();
  return whereLine(ctx, {
    text: 'New meetings go to',
    dest: destinationFor(snapshot, ''),
    pick: (chosen) => ctx.send({ type: 'notula_default', workspace: chosen.workspace, folder: chosen.folder }),
    clear: snapshot?.memory.default ? () => ctx.send({ type: 'notula_default', clear: true }) : undefined,
  });
}
