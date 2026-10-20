import type { LogQueueMessage } from '../inbound/extract';
import type { MatchResult } from '../matching/people';
import type { EmailLogConfig } from '../types';
import { truncate } from '../inbound/body';

const MAX_ITEM_NAME = 255;
const MAX_NOTES = 2000;

function footerLines(msg: LogQueueMessage, match: MatchResult, ownerUserId: number | null): string[] {
  const others = msg.counterparts.join(', ');
  const lines =
    msg.kind === 'forward'
      ? [`Received from ${others}, forwarded by ${msg.staffEmail}`]
      : [others ? `Sent by ${msg.staffEmail} to ${others}` : `Sent by ${msg.staffEmail}`];
  if (match.unmatched.length) lines.push(`Not on anyone's record: ${match.unmatched.join(', ')}`);
  if (msg.attachmentNames.length) lines.push(`Attachments (not saved): ${msg.attachmentNames.join(', ')}`);
  if (ownerUserId === null) lines.push(`Logged by ${msg.staffEmail}`);
  return lines;
}

// The footer says who and what was logged, so when the cap bites it is the body that gives way.
function notesText(body: string, footer: string): string {
  if (!body) return footer;
  const room = MAX_NOTES - footer.length - 2;
  if (room <= 0) return footer;
  return `${truncate(body, room)}\n\n${footer}`;
}

/** Maps a queued message and its People match to the Activities (Logged) create_item inputs. */
export function buildActivity(
  msg: LogQueueMessage,
  match: MatchResult,
  ownerUserId: number | null,
  config: EmailLogConfig,
): { name: string; columnValues: Record<string, unknown> } {
  const a = config.activities;
  const [date, timeZ] = new Date(msg.dateISO).toISOString().split('T') as [string, string];
  const columnValues: Record<string, unknown> = {
    [a.activityTypeColumn]: { label: a.activityTypeLabel },
    [a.dateColumn]: { date, time: timeZ.slice(0, 8) },
    [a.statusColumn]: { label: match.personItemIds.length ? a.doneLabel : a.needsPersonLabel },
    [a.notesColumn]: { text: notesText(msg.body, footerLines(msg, match, ownerUserId).join('\n')) },
    [a.messageHashColumn]: msg.messageIdHash,
  };
  if (ownerUserId !== null) columnValues[a.ownerColumn] = { personsAndTeams: [{ id: ownerUserId, kind: 'person' }] };
  if (match.personItemIds.length) columnValues[a.personColumn] = { item_ids: match.personItemIds.map(Number) };

  return { name: truncate(msg.subject, MAX_ITEM_NAME), columnValues };
}
