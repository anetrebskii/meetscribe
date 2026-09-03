import type { Meeting } from './types';

/**
 * The document a finished call becomes in the repository.
 *
 * Ordinary Markdown with a `type: meeting` frontmatter and no trace of how it
 * arrived. Notes run oldest first, unlike the panel, because this is read a
 * month later beside a chronological transcript. `Download .md` keeps its own
 * format; this one is Notula's.
 */

/** Two minutes and one line, or one note: below that a call is a misdial, not a meeting. */
export const MIN_MEETING_MS = 2 * 60_000;

export function worthSaving(meeting: Meeting): boolean {
  if (meeting.notes.length > 0) return true;
  const ended = meeting.endTime ?? Date.now();
  return ended - meeting.startTime >= MIN_MEETING_MS && meeting.entries.length > 0;
}

export function participantNames(meeting: Pick<Meeting, 'participants' | 'meetingCode'>): string[] {
  const names = Object.values(meeting.participants ?? {}).filter(name => name && name !== meeting.meetingCode && !name.startsWith('@'));
  return [...new Set(names)];
}

const pad = (n: number): string => String(n).padStart(2, '0');
const clock = (at: number): string => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const day = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** A YAML scalar that stays the same words: bare where YAML lets it, quoted otherwise. */
const scalar = (value: string): string =>
  /^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/.test(value) && !/^(true|false|null|yes|no|on|off)$/i.test(value)
    ? value
    : JSON.stringify(value);

export function meetingTitle(meeting: Pick<Meeting, 'title' | 'meetingCode'>): string {
  const title = meeting.title.trim();
  return title === '' || title === 'unknown' ? meeting.meetingCode : title;
}

/** `2026-09-04 Weekly sync`: date first so the folder sorts itself. Notula adds `.md` and settles collisions. */
export function documentName(meeting: Pick<Meeting, 'title' | 'meetingCode' | 'startTime'>): string {
  return `${day(meeting.startTime)} ${meetingTitle(meeting)}`;
}

export function meetingDocument(meeting: Meeting): string {
  const head = ['---', 'type: meeting', `created: ${day(meeting.startTime)}`];
  const people = participantNames(meeting);
  if (people.length > 0) head.push(`participants: [${people.map(scalar).join(', ')}]`);
  head.push('tags: [google-meet]', '---', '');

  const body = [`# ${meetingTitle(meeting)}`];
  const notes = [...meeting.notes].sort((a, b) => a.timestamp - b.timestamp);
  if (notes.length > 0) {
    body.push('', '## Notes', '');
    for (const note of notes) body.push(`- _(${clock(note.timestamp)})_ ${note.text.replace(/\s*\n\s*/g, ' ')}`);
  }
  const entries = meeting.entries.filter(entry => entry.text.trim() !== '');
  if (entries.length > 0) {
    body.push('', '## Transcript');
    let speaker: string | undefined;
    for (const entry of entries) {
      if (entry.speaker !== speaker) {
        body.push('', `**${entry.speaker || 'Unknown'}** _(${clock(entry.timestamp)})_`);
        speaker = entry.speaker;
      }
      body.push('', entry.text.trim());
    }
  }
  return `${head.join('\n')}\n${body.join('\n')}\n`;
}
