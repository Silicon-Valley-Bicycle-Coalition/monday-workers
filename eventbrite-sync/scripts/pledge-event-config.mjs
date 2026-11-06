#!/usr/bin/env node
// Prints the pledge.events block for one Eventbrite event, from its questions, for a person to review
// and paste into config/sandbox.json or config/svbc.json. Reads only the event's question definitions,
// never its attendees, and writes nothing. Run it on the draft, and deploy before publishing.
//
// Usage (from eventbrite-sync/):
//   EVENTBRITE_PRIVATE_TOKEN=... node scripts/pledge-event-config.mjs --event-id <id> --year <n>

import { readArg } from './backfill-orders-lib.mjs';
import { buildEventConfig } from './pledge-event-config-lib.mjs';

const API = 'https://www.eventbriteapi.com/v3';
const token = process.env.EVENTBRITE_PRIVATE_TOKEN;
const eventId = readArg(process.argv, '--event-id', null);
const year = Number(readArg(process.argv, '--year', NaN));
if (!token || !/^\d+$/.test(eventId ?? '') || !Number.isInteger(year)) {
  console.error('pledge-event-config: EVENTBRITE_PRIVATE_TOKEN, --event-id <numeric id> and --year <n> are required');
  process.exit(1);
}

const questions = [];
let continuation = null;
do {
  const url = new URL(`${API}/events/${eventId}/questions/`);
  if (continuation) url.searchParams.set('continuation', continuation);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.error(`pledge-event-config: Eventbrite answered HTTP ${res.status}`);
    process.exit(1);
  }
  const body = await res.json();
  questions.push(...(body.questions ?? []));
  continuation = body.pagination?.has_more_items ? body.pagination.continuation : null;
} while (continuation);

const { config, notes } = buildEventConfig(questions, year);
for (const note of notes) console.error(`pledge-event-config: ${note}`);
console.log(JSON.stringify({ [eventId]: config }, null, 2));
