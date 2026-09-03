/**
 * What the extension remembers about Notula, in `chrome.storage.local`.
 *
 * Four keys. The connection (port and token), one record per meeting saying
 * where it went or why it did not, the destination each recurring call goes
 * to, and the two notices that show once.
 */

export interface Connection {
  port?: number;
  token?: string;
  pairedAt?: number;
}

/** A workspace root on disk and a folder inside it. */
export interface Destination {
  workspace: string;
  folder: string;
}

export type SaveState = 'saving' | 'saved' | 'queued' | 'held' | 'failed' | 'tooShort';

export interface MeetingSave extends Destination {
  state: SaveState;
  path?: string;
  savedAt?: number;
  /** When `saved`: the file has since gone from the workspace. */
  gone?: boolean;
}

export interface FolderMemory {
  /** Where a call with no memory of its own goes. Unset, each call is asked, unless Notula knows exactly one repository. */
  default?: Destination;
  byCode: Record<string, Destination>;
}

export interface Notices {
  renamed?: 'unseen' | 'seen';
  backfill?: 'unseen' | 'seen';
}

export const DEFAULT_FOLDER = 'meetings';

const KEYS = {
  connection: 'notula',
  saves: 'notulaMeetings',
  folders: 'notulaFolders',
  notices: 'notulaNotices',
} as const;

async function read<T>(key: string, fallback: T): Promise<T> {
  try {
    const stored = await chrome.storage.local.get(key);
    const value = stored[key];
    return value && typeof value === 'object' ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

async function write(key: string, value: unknown): Promise<void> {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch { /* storage full or context gone; the next write tries again */ }
}

const isDestination = (value: unknown): value is Destination =>
  typeof value === 'object' && value !== null &&
  typeof (value as Destination).workspace === 'string' && (value as Destination).workspace !== '' &&
  typeof (value as Destination).folder === 'string' && (value as Destination).folder !== '';

export const readConnection = (): Promise<Connection> => read<Connection>(KEYS.connection, {});
export const writeConnection = (connection: Connection): Promise<void> => write(KEYS.connection, connection);

export const readSaves = (): Promise<Record<string, MeetingSave>> =>
  read<Record<string, MeetingSave>>(KEYS.saves, {}).then(saves =>
    Object.fromEntries(Object.entries(saves).map(([id, one]) => [id, { ...one, workspace: typeof one.workspace === 'string' ? one.workspace : '' }])),
  );

export async function writeSave(meetingId: string, save: MeetingSave | undefined): Promise<Record<string, MeetingSave>> {
  const saves = await readSaves();
  if (save === undefined) delete saves[meetingId];
  else saves[meetingId] = save;
  await write(KEYS.saves, saves);
  return saves;
}

export const readFolders = (): Promise<FolderMemory> =>
  read<{ default?: unknown; byCode?: Record<string, unknown> }>(KEYS.folders, {}).then(memory => ({
    ...(isDestination(memory.default) ? { default: memory.default } : {}),
    byCode: Object.fromEntries(Object.entries(memory.byCode ?? {}).filter(([, one]) => isDestination(one))) as Record<string, Destination>,
  }));
export const writeFolders = (memory: FolderMemory): Promise<void> => write(KEYS.folders, memory);

export const readNotices = (): Promise<Notices> => read<Notices>(KEYS.notices, {});
export const writeNotices = (notices: Notices): Promise<void> => write(KEYS.notices, notices);
