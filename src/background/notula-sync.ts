import type { Meeting } from '../utils/types';
import {
  NotulaError,
  askToPair,
  createDocument,
  deleteDocument,
  folders as listFolders,
  moveDocument,
  openDocument,
  pairAnswer,
  probe,
  replaceDocument,
  workspaces as listWorkspaces,
} from '../utils/notula';
import type { DocumentAt, WorkspaceInfo } from '../utils/notula';
import {
  DEFAULT_FOLDER,
  readConnection,
  readFolders,
  readNotices,
  readSaves,
  writeConnection,
  writeFolders,
  writeNotices,
  writeSave,
} from '../utils/notula-state';
import type { Connection, Destination, FolderMemory, MeetingSave, Notices } from '../utils/notula-state';
import { documentName, meetingDocument, worthSaving } from '../utils/meeting-document';
import { getMeeting, getMeetings } from '../utils/meeting-store';

/**
 * Everything the extension does with Notula, from the service worker.
 *
 * The connection is checked on three occasions and never polled: the browser
 * started, the panel or the popup was opened, a meeting ended. A meeting that
 * ends while Notula is closed waits in the queue, and the queue goes out the
 * next time any of the three happens. Pairing is the one place with a loop,
 * and it is bounded by the two minutes the code lives.
 */

export type Status =
  | { state: 'notPaired' }
  | { state: 'appClosed' }
  | { state: 'noWorkspace' }
  | { state: 'paired' };

export type PairStage = 'explaining' | 'pairing' | 'paired' | 'denied' | 'expired' | 'busy';

export interface Snapshot {
  status: Status;
  /** The folders Notula has open or remembers, open ones first. */
  workspaces: WorkspaceInfo[];
  /** Each workspace's folders, by root. */
  folders: Record<string, string[]>;
  memory: FolderMemory;
  saves: Record<string, MeetingSave>;
  notices: Notices;
  backfill: number;
}

const NAME = 'Notula for Google Meet';
const SAVES = 'Google Meet meetings';
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIR_POLL_MS = 2000;
const PAIR_TTL_MS = 120_000;
const FIELDS = [{ key: 'participants', type: 'list' as const, source: 'people' as const }];

let broadcast: (message: unknown) => void = () => {};
let status: Status = { state: 'notPaired' };
let knownWorkspaces: WorkspaceInfo[] = [];
let knownFolders: Record<string, string[]> = {};
let pairing: { code: string; port: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
let checking: Promise<Status> | null = null;

export function configure(send: (message: unknown) => void): void {
  broadcast = send;
}

/** `chrome.runtime.onInstalled`: an update over MeetScribe is told once that the name changed. */
export async function noteUpdate(previousVersion: string | undefined): Promise<void> {
  const notices = await readNotices();
  if (notices.renamed !== undefined) return;
  if (previousVersion === undefined || !previousVersion.startsWith('2.')) return;
  await writeNotices({ ...notices, renamed: 'unseen' });
}

export async function snapshot(): Promise<Snapshot> {
  const [memory, saves, notices] = await Promise.all([readFolders(), readSaves(), readNotices()]);
  return {
    status,
    workspaces: knownWorkspaces,
    folders: knownFolders,
    memory,
    saves,
    notices,
    backfill: notices.backfill === 'unseen' ? backlog(saves).length : 0,
  };
}

async function tell(): Promise<void> {
  broadcast({ type: 'notula_snapshot', snapshot: await snapshot() });
}

/** One of the three occasions. Answers with the status and empties the queue if it can. */
export function check(): Promise<Status> {
  if (checking) return checking;
  checking = (async () => {
    const connection = await readConnection();
    if (!connection.token) {
      status = { state: 'notPaired' };
    } else {
      const found = await probe(connection.port);
      if (!found) {
        status = { state: 'appClosed' };
      } else {
        if (found.port !== connection.port) await writeConnection({ ...connection, port: found.port });
        try {
          knownWorkspaces = await listWorkspaces(found.port, connection.token);
          const listed: Record<string, string[]> = {};
          for (const one of knownWorkspaces) {
            try {
              listed[one.root] = await listFolders(found.port, connection.token, one.root);
            } catch { /* a workspace that stopped answering is still a workspace */ }
          }
          knownFolders = listed;
          status = knownWorkspaces.length > 0 ? { state: 'paired' } : { state: 'noWorkspace' };
        } catch (error) {
          if (error instanceof NotulaError && error.kind === 'unauthorized') {
            await writeConnection({});
            status = { state: 'notPaired' };
          } else {
            status = { state: 'appClosed' };
          }
        }
      }
    }
    await tell();
    if (status.state === 'paired') void flush();
    return status;
  })().finally(() => {
    checking = null;
  });
  return checking;
}

/** Meetings that ended and were never offered to Notula. */
function backlog(saves: Record<string, MeetingSave>): Omit<Meeting, 'entries'>[] {
  return getMeetings().filter(m => m.endTime !== null && saves[m.id] === undefined).filter(m => {
    const full = getMeeting(m.id);
    return full !== null && worthSaving(full);
  });
}

async function withConnection(): Promise<{ port: number; token: string } | null> {
  const connection = await readConnection();
  if (!connection.token || !connection.port) return null;
  return { port: connection.port, token: connection.token };
}

/**
 * Where a call goes: what was remembered for its code, else the default, else
 * the only workspace Notula knows and `meetings/` in it. With several
 * workspaces and no default there is no answer: the card asks, and the answer
 * is remembered for the code, so a recurring meeting is asked once.
 */
async function destinationFor(code: string): Promise<Destination | null> {
  const memory = await readFolders();
  if (memory.byCode[code]) return memory.byCode[code];
  if (memory.default) return memory.default;
  return knownWorkspaces.length === 1 ? { workspace: knownWorkspaces[0].root, folder: DEFAULT_FOLDER } : null;
}

/** A record with nowhere to go yet. */
const NOWHERE: Destination = { workspace: '', folder: '' };

async function setSave(meetingId: string, save: MeetingSave | undefined): Promise<void> {
  await writeSave(meetingId, save);
  broadcast({ type: 'notula_save', meetingId, save });
}

const placed = (state: MeetingSave['state'], dest: Destination, rest: Partial<MeetingSave> = {}): MeetingSave => ({
  ...rest,
  state,
  workspace: dest.workspace,
  folder: dest.folder,
});

/**
 * The end of a meeting, and every retry after it.
 *
 * `manual` is a press of Save: it ignores the length threshold and the held
 * state, because the person has said what they want. Everything else is the
 * automatic path, which stays quiet about calls too short to be meetings.
 */
export async function save(meetingId: string, manual = false): Promise<void> {
  const connection = await withConnection();
  if (!connection) return;
  const meeting = getMeeting(meetingId);
  if (!meeting) return;
  const saves = await readSaves();
  const existing = saves[meetingId];
  const dest: Destination | null = existing?.workspace
    ? { workspace: existing.workspace, folder: existing.folder }
    : await destinationFor(meeting.meetingCode);
  if (!manual) {
    // Held is a person's answer. Saved is not: a call saved while it was still
    // going is written again at its end, with the rest of it.
    if (existing?.state === 'held') return;
    if (existing?.state !== 'saved' && !worthSaving(meeting)) {
      await setSave(meetingId, placed('tooShort', dest ?? NOWHERE));
      return;
    }
  }
  if (!dest) {
    if (knownWorkspaces.length === 0) {
      status = { state: 'noWorkspace' };
      await setSave(meetingId, placed('queued', NOWHERE, existing));
      await tell();
      return;
    }
    await setSave(meetingId, placed('held', NOWHERE, existing));
    return;
  }
  await setSave(meetingId, placed('saving', dest, existing));

  const content = meetingDocument(meeting);
  try {
    let doc: DocumentAt;
    const previous: DocumentAt | null = existing?.path && !existing.gone ? { workspace: existing.workspace, path: existing.path } : null;
    if (previous) {
      try {
        doc = await replaceDocument(connection.port, connection.token, previous, content);
      } catch (error) {
        if (!(error instanceof NotulaError) || error.kind !== 'gone') throw error;
        doc = await createDocument(connection.port, connection.token, { ...dest, name: documentName(meeting), content, fields: FIELDS });
      }
    } else {
      doc = await createDocument(connection.port, connection.token, { ...dest, name: documentName(meeting), content, fields: FIELDS });
    }
    await setSave(meetingId, placed('saved', { workspace: doc.workspace, folder: folderOf(doc.path) || dest.folder }, { path: doc.path, savedAt: Date.now() }));
  } catch (error) {
    const kind = error instanceof NotulaError ? error.kind : 'refused';
    if (kind === 'unauthorized') {
      await writeConnection({});
      status = { state: 'notPaired' };
      await setSave(meetingId, undefined);
      await tell();
      return;
    }
    if (kind === 'unreachable' || (kind === 'workspace' && knownWorkspaces.length === 0)) {
      status = kind === 'unreachable' ? { state: 'appClosed' } : { state: 'noWorkspace' };
      await setSave(meetingId, placed('queued', dest, existing));
      await tell();
      return;
    }
    // Edited in Notula since it was written: theirs stands, and what was saved stays saved.
    if (kind === 'changed' && existing?.state === 'saved') {
      await setSave(meetingId, existing);
      return;
    }
    await setSave(meetingId, placed('failed', dest, existing));
  }
}

const folderOf = (path: string): string => path.slice(0, path.lastIndexOf('/'));

/** Everything that waited for Notula, one after another so the person sees one line, not fifteen. */
export async function flush(): Promise<void> {
  const saves = await readSaves();
  for (const [meetingId, entry] of Object.entries(saves)) {
    if (entry.state !== 'queued' && entry.state !== 'saving') continue;
    if (status.state !== 'paired') return;
    await save(meetingId);
  }
}

export async function undo(meetingId: string): Promise<void> {
  const connection = await withConnection();
  const saves = await readSaves();
  const existing = saves[meetingId];
  if (!connection || !existing?.path) return;
  try {
    await deleteDocument(connection.port, connection.token, { workspace: existing.workspace, path: existing.path });
    await setSave(meetingId, placed('held', existing));
  } catch (error) {
    if (error instanceof NotulaError && error.kind === 'gone') {
      await setSave(meetingId, placed('held', existing));
      return;
    }
    if (error instanceof NotulaError && error.kind === 'changed') {
      await setSave(meetingId, { ...existing, state: 'saved' });
      return;
    }
    await setSave(meetingId, { ...existing, state: 'failed' });
  }
}

export async function open(meetingId: string): Promise<void> {
  const connection = await withConnection();
  const saves = await readSaves();
  const existing = saves[meetingId];
  if (!connection || !existing?.path) return;
  try {
    await openDocument(connection.port, connection.token, { workspace: existing.workspace, path: existing.path });
  } catch (error) {
    if (error instanceof NotulaError && error.kind === 'gone') {
      await setSave(meetingId, { ...existing, gone: true });
    }
  }
}

/**
 * A destination chosen on a card or the live footer: remembered for the call,
 * and the file carried there if it exists. Inside one workspace that is a
 * move; across two it is a delete and a fresh write, because a document
 * belongs to one repository and Notula does not carry files between them.
 */
export async function chooseDestination(code: string, dest: Destination, meetingId?: string): Promise<void> {
  const memory = await readFolders();
  await writeFolders({ ...memory, byCode: { ...memory.byCode, [code]: dest } });
  if (meetingId) {
    const saves = await readSaves();
    const existing = saves[meetingId];
    const connection = await withConnection();
    if (existing && existing.state === 'saved' && existing.path && !existing.gone && connection) {
      const from: DocumentAt = { workspace: existing.workspace, path: existing.path };
      try {
        if (dest.workspace === existing.workspace) {
          const moved = await moveDocument(connection.port, connection.token, from, dest.folder);
          await setSave(meetingId, placed('saved', { workspace: moved.workspace, folder: folderOf(moved.path) || dest.folder }, { ...existing, path: moved.path }));
        } else {
          await deleteDocument(connection.port, connection.token, from);
          await setSave(meetingId, placed('held', dest));
          await save(meetingId, true);
        }
      } catch (error) {
        if (error instanceof NotulaError && error.kind === 'gone') await setSave(meetingId, { ...existing, gone: true });
      }
    } else if (existing && existing.state !== 'saved') {
      await setSave(meetingId, placed(existing.state, dest, existing));
    }
  }
  await tell();
}

export async function setDefault(dest: Destination | undefined): Promise<void> {
  const memory = await readFolders();
  await writeFolders({ byCode: memory.byCode, ...(dest ? { default: dest } : {}) });
  await tell();
}

export async function dismiss(which: keyof Notices): Promise<void> {
  const notices = await readNotices();
  await writeNotices({ ...notices, [which]: 'seen' });
  if (which === 'backfill') {
    for (const meeting of backlog(await readSaves())) {
      await writeSave(meeting.id, placed('held', (await destinationFor(meeting.meetingCode)) ?? NOWHERE));
    }
  }
  await tell();
}

/** The banner's Save all; with a destination when there was no default to send them to. */
export async function saveAll(dest?: Destination): Promise<void> {
  const notices = await readNotices();
  await writeNotices({ ...notices, backfill: 'seen' });
  for (const meeting of backlog(await readSaves())) {
    if (dest) await chooseDestination(meeting.meetingCode, dest, meeting.id);
    await save(meeting.id, true);
  }
  await tell();
}

export async function disconnect(): Promise<void> {
  await writeConnection({});
  status = { state: 'notPaired' };
  await tell();
}

/**
 * The press on "Save to your Git repo via Notula", and every five seconds of
 * the waiting screen after it. Finds the app or says it is not there; shows a
 * code and waits for the dialog on the other side to be answered.
 */
export async function startPairing(): Promise<void> {
  if (pairing) {
    broadcast({ type: 'notula_pair', stage: 'pairing', code: pairing.code });
    return;
  }
  const found = await probe((await readConnection()).port);
  if (!found) {
    broadcast({ type: 'notula_pair', stage: 'explaining' });
    return;
  }
  const code = Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  let answer: 'pending' | 'busy';
  try {
    answer = await askToPair(found.port, code, NAME, SAVES);
  } catch {
    broadcast({ type: 'notula_pair', stage: 'explaining' });
    return;
  }
  if (answer === 'busy') {
    broadcast({ type: 'notula_pair', stage: 'busy' });
    return;
  }
  pairing = { code, port: found.port, timer: null };
  broadcast({ type: 'notula_pair', stage: 'pairing', code });
  const started = Date.now();
  const poll = async (): Promise<void> => {
    if (!pairing || pairing.code !== code) return;
    let stage: PairStage | null = null;
    try {
      const reply = await pairAnswer(found.port, code);
      if (reply.status === 'allowed') {
        await writeConnection({ port: found.port, token: reply.token, pairedAt: Date.now() });
        const notices = await readNotices();
        if (notices.backfill === undefined) await writeNotices({ ...notices, backfill: 'unseen' });
        stage = 'paired';
      } else if (reply.status === 'denied') stage = 'denied';
      else if (reply.status === 'expired') stage = 'expired';
    } catch {
      stage = Date.now() - started > PAIR_TTL_MS ? 'expired' : null;
    }
    if (stage === null && Date.now() - started > PAIR_TTL_MS) stage = 'expired';
    if (stage === null) {
      pairing.timer = setTimeout(() => void poll(), PAIR_POLL_MS);
      return;
    }
    pairing = null;
    broadcast({ type: 'notula_pair', stage, code });
    if (stage === 'paired') await check();
  };
  pairing.timer = setTimeout(() => void poll(), PAIR_POLL_MS);
}

export function cancelPairing(): void {
  if (pairing?.timer) clearTimeout(pairing.timer);
  pairing = null;
}

const destinationIn = (message: Record<string, unknown>): Destination | null =>
  typeof message.workspace === 'string' && message.workspace !== '' && typeof message.folder === 'string' && message.folder !== ''
    ? { workspace: message.workspace, folder: message.folder }
    : null;

/** What the panel and the popup send, by type. */
export async function handle(message: { type: string } & Record<string, unknown>): Promise<boolean> {
  switch (message.type) {
    case 'notula_check':
      await check();
      return true;
    case 'notula_pair_start':
      await startPairing();
      return true;
    case 'notula_pair_cancel':
      cancelPairing();
      return true;
    case 'notula_save': {
      const meetingId = String(message.meetingId);
      const dest = destinationIn(message);
      const meeting = dest ? getMeeting(meetingId) : null;
      if (dest && meeting) await chooseDestination(meeting.meetingCode, dest, meetingId);
      await save(meetingId, true);
      return true;
    }
    case 'notula_save_all':
      await saveAll(destinationIn(message) ?? undefined);
      return true;
    case 'notula_undo':
      await undo(String(message.meetingId));
      return true;
    case 'notula_open':
      await open(String(message.meetingId));
      return true;
    case 'notula_destination': {
      const dest = destinationIn(message);
      if (dest) await chooseDestination(String(message.code), dest, typeof message.meetingId === 'string' ? message.meetingId : undefined);
      return true;
    }
    case 'notula_default': {
      if (message.clear === true) {
        await setDefault(undefined);
        return true;
      }
      const dest = destinationIn(message);
      if (dest) await setDefault(dest);
      return true;
    }
    case 'notula_dismiss':
      await dismiss(message.which === 'backfill' ? 'backfill' : 'renamed');
      return true;
    case 'notula_disconnect':
      await disconnect();
      return true;
    default:
      return false;
  }
}

export async function onMeetingEnded(meetingId: string): Promise<void> {
  const connection: Connection = await readConnection();
  if (!connection.token) return;
  await save(meetingId);
  await check();
}
