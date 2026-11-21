// What a call or text looks like on a People item (design "What lands in Monday"). Title and
// summary are plain text capped at 255 characters; content is escaped HTML. Nothing here reads a
// phone number or message text: the person is named by their People item, the staff member by the
// name Zoom gave the line.

export const TIME_ZONE = 'America/Los_Angeles';
export const MAX_TIMELINE_TEXT = 255;

export interface LoggableEvent {
  kind: 'call' | 'text';
  occurredAt: string;
  direction: 'inbound' | 'outbound';
  result: string | null;
  talkSeconds: number | null;
  staffName: string | null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const cap = (text: string) => (text.length <= MAX_TIMELINE_TEXT ? text : `${text.slice(0, MAX_TIMELINE_TEXT - 1)}…`);

/**
 * Whether a call connected. Zoom's call-element `result` values are read loosely until #50's real
 * fixtures confirm them: any talk time counts, and so does a result naming an answer or connection
 * (but not "no answer").
 */
export function isAnswered(event: Pick<LoggableEvent, 'kind' | 'result' | 'talkSeconds'>): boolean {
  if (event.kind === 'text') return true;
  if ((event.talkSeconds ?? 0) > 0) return true;
  const result = (event.result ?? '').toLowerCase();
  if (/no[\s_-]?answer/.test(result)) return false;
  return /answer|connect/.test(result);
}

/** "45 sec", "12 min", "1 hr 5 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** The Pacific calendar date (YYYY-MM-DD) of an instant, for Last Phone Contact. */
export function pacificDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function pacificTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(iso));
}

const capitalized = (direction: string) => direction.charAt(0).toUpperCase() + direction.slice(1);

export function entryFor(event: LoggableEvent, personName: string, smsUrl: string | null): { title: string; summary: string; content: string } {
  const line = event.staffName === null ? 'a staff line' : `${event.staffName}'s line`;
  const when = pacificTime(event.occurredAt);
  const inbound = event.direction === 'inbound';

  if (event.kind === 'text') {
    const title = `Text ${inbound ? 'from' : 'to'} ${personName}`;
    const lead = `${capitalized(event.direction)} text on ${line}, ${when}. The message itself stays in Zoom, where the line's owner can read it.`;
    const link = smsUrl === null ? '' : `<p><a href="${escapeHtml(smsUrl)}">Open in Zoom</a></p>`;
    return { title: cap(title), summary: cap(`On ${line}`), content: `<p>${escapeHtml(lead)}</p>${link}` };
  }

  if (isAnswered(event)) {
    const length = event.talkSeconds !== null && event.talkSeconds > 0 ? formatDuration(event.talkSeconds) : null;
    const summary = length === null ? capitalized(event.direction) : `${capitalized(event.direction)} · ${length}`;
    const lead = `${capitalized(event.direction)} call on ${line}, ${when}${length === null ? '' : `, ${length}`}.`;
    return { title: cap(`Call with ${personName}`), summary: cap(summary), content: `<p>${escapeHtml(lead)}</p>` };
  }

  const outcome = /voicemail/i.test(event.result ?? '') ? 'voicemail' : 'no answer';
  const title = `Missed call ${inbound ? 'from' : 'to'} ${personName}`;
  const lead = `${capitalized(event.direction)} call on ${line}, ${when}: ${outcome}.`;
  return { title: cap(title), summary: cap(`${capitalized(event.direction)} · ${outcome}`), content: `<p>${escapeHtml(lead)}</p>` };
}
