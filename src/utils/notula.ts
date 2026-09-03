/**
 * The client half of Notula's loopback API.
 *
 * Notula listens on the first free port of these eight; the extension probes
 * them in order and remembers the one that answered. Nothing here is specific
 * to meetings: it pairs, lists the workspaces Notula knows and their folders,
 * and writes, replaces, deletes, moves and opens documents in any of them.
 */

export const PORTS = [51789, 51790, 51791, 51792, 51793, 51794, 51795, 51796] as const;
export const PROTOCOL = 1;

export type NotulaFailure = 'unreachable' | 'unauthorized' | 'workspace' | 'gone' | 'changed' | 'refused';

export class NotulaError extends Error {
  constructor(readonly kind: NotulaFailure, readonly status = 0, detail = '') {
    super(detail || kind);
  }
}

export interface Hello {
  app: string;
  protocol: number;
  /** Whether Notula has any folder open or remembered to save into. */
  workspace: boolean;
}

export type PairAnswer =
  | { status: 'pending' | 'denied' | 'expired' }
  | { status: 'allowed'; token: string };

export interface WorkspaceInfo {
  /** The folder on disk, which is also how every other call names it. */
  root: string;
  name: string;
}

export interface DocumentField {
  key: string;
  type: 'text' | 'number' | 'checkbox' | 'date' | 'datetime' | 'list';
  source?: 'people';
}

/** Where a document is: the workspace root and the path inside it. */
export interface DocumentAt {
  workspace: string;
  path: string;
}

const base = (port: number): string => `http://127.0.0.1:${port}/v1`;

async function call(
  port: number,
  path: string,
  init: { method?: string; token?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.token) headers['Authorization'] = `Bearer ${init.token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 4000);
  try {
    const response = await fetch(`${base(port)}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    if (response.status === 401) throw new NotulaError('unauthorized', 401);
    return response;
  } catch (error) {
    if (error instanceof NotulaError) throw error;
    throw new NotulaError('unreachable');
  } finally {
    clearTimeout(timer);
  }
}

async function refusal(response: Response): Promise<never> {
  let reason = '';
  try {
    reason = ((await response.json()) as { error?: string }).error ?? '';
  } catch { /* no body */ }
  if (response.status === 404 && (reason === 'gone' || reason === 'unknown')) throw new NotulaError('gone', 404);
  if (response.status === 404 && reason === 'workspace') throw new NotulaError('workspace', 404);
  if (response.status === 409) throw new NotulaError('changed', 409);
  throw new NotulaError('refused', response.status, reason);
}

/** The port Notula answers on, the remembered one tried first. */
export async function probe(remembered?: number): Promise<{ port: number; hello: Hello } | null> {
  const order = remembered ? [remembered, ...PORTS.filter(p => p !== remembered)] : [...PORTS];
  for (const port of order) {
    try {
      const response = await call(port, '/hello', { timeoutMs: 1500 });
      if (!response.ok) continue;
      const hello = (await response.json()) as Hello;
      if (hello.app === 'notula') return { port, hello };
    } catch { /* next port */ }
  }
  return null;
}

export async function askToPair(port: number, code: string, name: string, saves: string): Promise<'pending' | 'busy'> {
  const response = await call(port, '/pair', { body: { code, name, saves } });
  if (response.status === 429) return 'busy';
  if (!response.ok) await refusal(response);
  return 'pending';
}

export async function pairAnswer(port: number, code: string): Promise<PairAnswer> {
  const response = await call(port, `/pair/${code}`);
  if (!response.ok) await refusal(response);
  return (await response.json()) as PairAnswer;
}

/** The folders Notula has open or remembers, the open ones first. */
export async function workspaces(port: number, token: string): Promise<WorkspaceInfo[]> {
  const response = await call(port, '/workspaces', { token });
  if (!response.ok) await refusal(response);
  return ((await response.json()) as { workspaces: WorkspaceInfo[] }).workspaces;
}

export async function folders(port: number, token: string, workspace: string): Promise<string[]> {
  const response = await call(port, `/folders?workspace=${encodeURIComponent(workspace)}`, { token });
  if (!response.ok) await refusal(response);
  return ((await response.json()) as { folders: string[] }).folders;
}

export async function createDocument(
  port: number,
  token: string,
  document: { workspace: string; folder: string; name: string; content: string; fields?: DocumentField[] },
): Promise<DocumentAt> {
  const response = await call(port, '/documents', { token, body: document, timeoutMs: 15000 });
  if (!response.ok) await refusal(response);
  return (await response.json()) as DocumentAt;
}

const at = (doc: DocumentAt, verb?: 'move' | 'open'): string =>
  `/documents/${encodeURIComponent(doc.path)}${verb ? `/${verb}` : ''}?workspace=${encodeURIComponent(doc.workspace)}`;

export async function replaceDocument(port: number, token: string, doc: DocumentAt, content: string): Promise<DocumentAt> {
  const response = await call(port, at(doc), { method: 'PUT', token, body: { content }, timeoutMs: 15000 });
  if (!response.ok) await refusal(response);
  return (await response.json()) as DocumentAt;
}

export async function deleteDocument(port: number, token: string, doc: DocumentAt): Promise<void> {
  const response = await call(port, at(doc), { method: 'DELETE', token });
  if (!response.ok) await refusal(response);
}

export async function moveDocument(port: number, token: string, doc: DocumentAt, folder: string): Promise<DocumentAt> {
  const response = await call(port, at(doc, 'move'), { token, body: { folder } });
  if (!response.ok) await refusal(response);
  return (await response.json()) as DocumentAt;
}

export async function openDocument(port: number, token: string, doc: DocumentAt): Promise<void> {
  const response = await call(port, at(doc, 'open'), { method: 'POST', token });
  if (!response.ok) await refusal(response);
}
