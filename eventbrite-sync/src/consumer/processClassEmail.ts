import { audienceSource } from '../classEmails/audienceSource';
import { classFields } from '../classEmails/fields';
import { KIND_LABEL, MAX_TIMELINE_TEXT, escapeHtml, fillPlaceholders, oneLine } from '../classEmails/text';
import { realName } from '../eventbrite/placeholder';
import { isFallbackItemName } from '../mapping/fallbackName';
import { nameParts } from '../matching/names';
import { matchPerson, peopleNameColumns } from '../matching/people';
import { isActive, statusText } from '../monday/client';
import { isItemGone } from '../monday/itemGone';
import { linkedItemId } from '../util/itemId';
import { stampOf } from './messages';
import type { ClassEmailQueueMessage, ProcessBatchDeps } from './processBatch';

// One recipient's share of the work after a class email went out, run from the write queue so each
// piece gets its own retries and the 30 seconds `waitUntil` allows after a response doesn't cap how
// many people a send can reach (GL#96). Two steps, chained so the order is kept: the timeline entry
// first (a thank-you's People link can create the person, and an entry shouldn't depend on that
// having happened), then, for a thank-you or missed-you, the follow-up write. A step that throws is
// retried by the queue on its own, so a retry never repeats an earlier step.
export async function processClassEmail(message: ClassEmailQueueMessage, deps: ProcessBatchDeps): Promise<void> {
  const { config, queue } = deps;
  const source = audienceSource(config, message.audience);
  if (source.board === null) {
    console.warn(`eventbrite-sync consumer: class email ${message.step} for event "${message.eventId}" skipped: no board to read`);
    return;
  }

  if (message.step === 'timeline') {
    await logToTimeline(message, deps, source);
    if (message.emailKind !== 'reminder') {
      await queue.send({
        kind: 'class-email', step: 'follow-up', eventId: message.eventId, emailKind: message.emailKind,
        audience: message.audience, registrationId: message.registrationId, ...stampOf(message),
      });
    }
    return;
  }
  await followUp(message, deps, source);
}

// The email on the person's Emails & Activities timeline, because Monday's own logging doesn't pick
// up mail sent as a Google Group. On their People item when the address matches, else their
// registration; never creates a person. Not idempotent (an entry can't be looked up), so a retry
// after a Monday error that landed anyway can post a second one; that is the price of retrying at all.
async function logToTimeline(message: Extract<ClassEmailQueueMessage, { step: 'timeline' }>, deps: ProcessBatchDeps, source: ReturnType<typeof audienceSource>): Promise<void> {
  const { eventStore, mondayClient: client, config } = deps;
  const customActivityId = config.attendeeSync.classEmails.timelineActivityId;
  if (customActivityId === null) return;
  const { eventId, registrationId, emailKind, sender, subject } = message;
  const boards = config.monday.boards;
  const ev = config.attendeeSync.events;

  const event = await eventStore.getEvent(eventId);
  if (event === null || event.mondayItemId === null) throw new Error(`eventbrite-sync consumer: event "${eventId}" has no Events item; cannot log the ${emailKind} timeline entry`);
  const [classItem] = await client.getItems(boards.events!, [event.mondayItemId], [ev.venueColumn, ev.addressColumn]);
  const fields = classFields(event, classItem?.columns[ev.venueColumn] ?? '', classItem?.columns[ev.addressColumn] ?? '');
  const className = classItem?.name ?? `Eventbrite event ${eventId}`;

  const [item] = await client.getItems(source.board!, [registrationId], [source.emailColumn, source.firstNameColumn]);
  const email = (item?.columns[source.emailColumn] ?? '').trim();
  const firstName = source.firstNameOf(item?.columns[source.firstNameColumn] ?? '');
  const peopleBoard = boards['people-live'];
  const person = peopleBoard != null && email !== '' ? await client.findItemByColumnValue(peopleBoard, config.attendeeSync.peopleEmailColumn, email) : null;
  const title = oneLine(fillPlaceholders(subject, { ...fields, 'First Name': firstName || null })).slice(0, MAX_TIMELINE_TEXT);
  const summary = `${KIND_LABEL[emailKind]} for ${oneLine(className)}. Sent by ${sender}.`;
  await client.createTimelineItem({
    itemId: person?.id ?? registrationId, customActivityId, title, timestamp: message.sentAt,
    summary: summary.slice(0, MAX_TIMELINE_TEXT),
    content: `<p>${escapeHtml(title)}</p><p>${escapeHtml(summary)}</p>`,
  });
}

// What the ledger doesn't cover: a missed-you marks No Show and a thank-you links People. Both are
// safe to repeat. A registration staff deleted since is dropped, not retried.
async function followUp(message: Extract<ClassEmailQueueMessage, { step: 'follow-up' }>, deps: ProcessBatchDeps, source: ReturnType<typeof audienceSource>): Promise<void> {
  const { mondayClient: client, config } = deps;
  const { eventId, registrationId, emailKind } = message;
  if (emailKind === 'reminder') return;
  const regBoard = source.board!;

  const write = async (values: Record<string, unknown>) => {
    try {
      await client.changeColumnValues(regBoard, registrationId, values);
    } catch (err) {
      if (!isItemGone(err)) throw err;
      console.warn(`eventbrite-sync consumer: class email follow-up: registration ${registrationId} on event "${eventId}" was deleted or archived; nothing written`);
    }
  };

  if (emailKind === 'missed-you') {
    // Fresh: staff may have checked someone in since the page was loaded.
    const [item] = await client.getItems(regBoard, [registrationId], [source.statusColumn]);
    if (!isActive(item) || statusText(item, source.statusColumn) !== source.signedUpStatus) return;
    await write({ [source.statusColumn]: source.noShowStatus });
    return;
  }

  const peopleBoard = config.monday.boards['people-live'];
  if (peopleBoard === null) return;
  // A volunteer has only the name column; its first name is split out of it.
  const splitName = source.firstNameColumn === source.nameColumn;
  const [item] = await client.getItems(regBoard, [registrationId], [source.emailColumn, source.linkColumn, source.nameColumn, ...(splitName ? [] : [source.firstNameColumn])]);
  if (!isActive(item)) return;
  if ((item.columns[source.linkColumn] ?? '').trim() !== '') return; // never overwrite a link
  // First and Last Name come from the name columns only. The person's item name can come from this
  // item's, which staff may have typed, but never the "Eventbrite attendee <id>" fallback.
  const names = nameParts({ firstName: splitName ? null : item.columns[source.firstNameColumn], name: item.columns[source.nameColumn] });
  const who = { email: item.columns[source.emailColumn], name: isFallbackItemName(item.name) ? realName(item.columns[source.nameColumn]) : item.name, ...names };
  const match = await matchPerson(client, peopleBoard, config.attendeeSync.peopleEmailColumn, who, peopleNameColumns(config));
  if (match.donorItemId === null) return;
  await write({ [source.linkColumn]: { item_ids: [linkedItemId(match.donorItemId)] } });
}
