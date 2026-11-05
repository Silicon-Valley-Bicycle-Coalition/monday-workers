import type { EventbriteAttendee } from '../eventbrite/client';
import { isPlaceholderAttendee, realEmail, realName } from '../eventbrite/placeholder';
import type { PledgeConfig, PledgeEventConfig, PledgeField } from '../types';
import { toISODate } from '../util/isoDate';

const MAX_TEXT = 2000;
const MAX_ITEM_NAME = 255;
const MULTI_SELECT_SEPARATOR = ' | ';

export function countyForZip(zip: string | null, zipCounty: Record<string, string[]>): string {
  if (zip === null || !/^\d{5}$/.test(zip)) return 'Unknown';
  for (const [county, zips] of Object.entries(zipCounty)) {
    if (zips.includes(zip)) return county;
  }
  return 'Outside';
}

// `buyer` is the order's buyer, fetched only for a placeholder attendee (null otherwise, or when the
// order is gone). Pure, apart from a warning that names the question and never the answer.
export function mapPledge(
  attendee: EventbriteAttendee,
  buyer: { name?: string | null; email?: string | null } | null,
  event: PledgeEventConfig,
  pledge: PledgeConfig
): { itemName: string; columnValues: Record<string, unknown> } {
  const cols = pledge.columns;
  const name = realName(attendee.profile?.name) ?? realName(buyer?.name);
  const email = realEmail(attendee.profile?.email) ?? realEmail(buyer?.email);
  const date = toISODate(attendee.created);

  const fields = new Map<PledgeField, string>();
  const other: string[] = [];
  for (const { question_id: questionId, question, answer } of attendee.answers ?? []) {
    if (typeof answer !== 'string' || answer.trim() === '' || typeof questionId !== 'string') continue;
    if (event.ignoreQuestions.includes(questionId)) continue;
    const field = event.questions[questionId];
    if (field === undefined) {
      other.push(`${question ?? questionId}: ${answer}`);
    } else {
      fields.set(field, answer);
    }
  }

  const zip = normalizeZip(fields.get('zip'));
  const columnValues: Record<string, unknown> = {
    [cols.attendeeIdColumn]: attendee.id,
    [cols.yearColumn]: String(event.year),
    [cols.statusColumn]: attendee.cancelled || attendee.refunded ? 'Canceled' : 'Pledged',
    [cols.detailsColumn]: isPlaceholderAttendee(attendee.profile) ? 'Buyer only' : 'Complete',
    [cols.countyColumn]: countyForZip(zip, pledge.zipCounty),
  };
  if (date !== null) columnValues[cols.dateColumn] = { date };
  if (email !== null) columnValues[cols.emailColumn] = { email, text: email };
  if (zip !== null) columnValues[cols.zipColumn] = zip;

  const label = (questionField: PledgeField, choice: string) => choiceLabel(choice, questionField, attendee, event);
  const days = fields.get('daysPledged');
  if (days !== undefined) columnValues[cols.daysPledgedColumn] = label('daysPledged', days);
  const rider = fields.get('riderType');
  if (rider !== undefined) columnValues[cols.riderTypeColumn] = { labels: rider.split(MULTI_SELECT_SEPARATOR).map((c) => label('riderType', c)) };
  const heard = fields.get('heardAbout');
  if (heard !== undefined) columnValues[cols.heardAboutColumn] = { labels: heard.split(MULTI_SELECT_SEPARATOR).map((c) => label('heardAbout', c)) };
  const who = fields.get('whoAsked');
  if (who !== undefined) columnValues[cols.whoAskedColumn] = cleanText(who);
  if (event.consentValues.includes(fields.get('consent') ?? '')) columnValues[cols.consentColumn] = { checked: 'true' };
  if (other.length > 0) columnValues[cols.otherAnswersColumn] = { text: cleanText(other.join('; ')) };

  return { itemName: (name ?? `Pledge ${attendee.id}`).slice(0, MAX_ITEM_NAME), columnValues };
}

function normalizeZip(answer: string | undefined): string | null {
  if (answer === undefined) return null;
  const trimmed = answer.trim();
  return /^\d{5}/.exec(trimmed)?.[0] ?? cleanText(trimmed);
}

function choiceLabel(choice: string, field: PledgeField, attendee: EventbriteAttendee, event: PledgeEventConfig): string {
  const mapped = event.choices[choice];
  if (mapped !== undefined) return mapped;
  const questionId = Object.keys(event.questions).find((id) => event.questions[id] === field);
  // Never the answer: it may be anything a person typed.
  console.warn(`eventbrite-sync pledge: attendee "${attendee.id}": question ${questionId} has a choice with no label in config; written as it arrived`);
  return cleanText(choice);
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}
