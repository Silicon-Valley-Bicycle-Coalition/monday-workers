import type { LogQueueMessage } from '../inbound/extract';
import type { TimelineItemInput } from '../monday/client';
import { escapeHtml } from '../email/escapeHtml';
import { truncate } from '../inbound/body';

// create_timeline_item's limits on title and summary.
const MAX_TITLE = 255;
const MAX_SUMMARY = 255;

/**
 * The Emails & Activities entry posted on each matched person, so a logged email shows on their
 * timeline as well as in the Activities (Logged) column. `notes` is the Activity item's Notes text,
 * so the two read the same; the url links back to that item, which stays the record.
 */
export function buildTimelineEntry(
  msg: LogQueueMessage,
  notes: string,
  itemUrl: string,
  customActivityId: string,
): Omit<TimelineItemInput, 'itemId'> {
  const oneLine = (msg.body || notes).replace(/\s+/g, ' ').trim();
  return {
    customActivityId,
    title: truncate(msg.subject, MAX_TITLE),
    summary: truncate(oneLine, MAX_SUMMARY),
    content: escapeHtml(notes).replace(/\n/g, '<br>'),
    timestamp: new Date(msg.dateISO).toISOString(),
    url: itemUrl,
  };
}
