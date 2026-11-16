// Read-only: for each pair of Eventbrite attendee ids that landed as two rows for one person on one
// event, fetch the event's attendee list from Eventbrite and say whether the pair is real there
// (same order, two live orders, one canceled, ...). Nothing is written anywhere.
//
// Usage (from eventbrite-sync/):
//   EVENTBRITE_PRIVATE_TOKEN=... node scripts/compare-attendee-pairs.mjs
//   EVENTBRITE_PRIVATE_TOKEN=... node scripts/compare-attendee-pairs.mjs --pairs pairs.json
//   EVENTBRITE_PRIVATE_TOKEN=... node scripts/compare-attendee-pairs.mjs --event 1384220283129 --attendees 22264977783,22291335293
//
// pairs.json: [{ "label": "...", "event": "<event id>", "attendees": ["<id>", "<id>"] }, ...]
// With no arguments it checks DEFAULT_PAIRS (the six pairs found on the sandbox Volunteers board).
// The token is the private token from SVBC's organizer account (see README, "APIs & auth"); it can
// read every order on the account, so keep it in your shell, not in a file.
import { readFileSync } from 'node:fs';
import { DEFAULT_PAIRS, classifyPair, indexAttendees, summarizeAttendee } from './compare-attendee-pairs-lib.mjs';

const API = 'https://www.eventbriteapi.com/v3';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument: ${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

function pairsFrom(args) {
  if (args.pairs) return JSON.parse(readFileSync(args.pairs, 'utf8'));
  if (args.event || args.attendees) {
    const ids = (args.attendees ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!args.event || ids.length !== 2) throw new Error('--event and --attendees <id>,<id> are both required');
    return [{ label: 'pair', event: args.event, attendees: ids }];
  }
  return DEFAULT_PAIRS;
}

async function get(url, token) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429 && attempt < 4) {
      const wait = Number(res.headers.get('retry-after')) || 5 * attempt;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Eventbrite ${res.status} for ${url.replace(/\?.*/, '')}: ${body.error_description ?? body.error ?? 'no detail'}`);
    }
    return res.json();
  }
}

// Every attendee of one event, following the continuation token. No `status` filter: "all" is not
// a valid choice, and omitting it lists canceled and refunded records too (verified 2026-11-11: 5
// attendees unfiltered vs 3 with status=attending), which are exactly what this check has to see.
async function listAttendees(eventId, token) {
  const out = [];
  let continuation = null;
  do {
    const qs = new URLSearchParams();
    if (continuation) qs.set('continuation', continuation);
    const page = await get(`${API}/events/${encodeURIComponent(eventId)}/attendees/?${qs}`, token);
    out.push(...(page.attendees ?? []));
    continuation = page.pagination?.has_more_items ? page.pagination.continuation : null;
  } while (continuation);
  return out;
}

async function main() {
  const token = process.env.EVENTBRITE_PRIVATE_TOKEN;
  if (!token) {
    console.error('EVENTBRITE_PRIVATE_TOKEN is not set (export it in your shell; this script never reads files for it)');
    process.exit(2);
  }
  const pairs = pairsFrom(parseArgs(process.argv.slice(2)));
  const eventCache = new Map();
  const counts = {};

  for (const pair of pairs) {
    if (!eventCache.has(pair.event)) eventCache.set(pair.event, indexAttendees(await listAttendees(pair.event, token)));
    const byId = eventCache.get(pair.event);
    const [a, b] = pair.attendees.map((id) => summarizeAttendee(byId.get(String(id))));
    const { verdict, note } = classifyPair(a, b);
    counts[verdict] = (counts[verdict] ?? 0) + 1;
    console.log(`\n${pair.label}  event ${pair.event}  ${verdict}`);
    console.log(`  ${note}`);
    pair.attendees.forEach((id, i) => {
      const s = i === 0 ? a : b;
      console.log(s
        ? `  ${id}: order ${s.orderId}, ${s.status}${s.cancelled ? ', cancelled' : ''}${s.refunded ? ', refunded' : ''}, ${s.ticketClass}, created ${s.created}`
        : `  ${id}: not listed`);
    });
  }
  console.log('\nsummary:', counts);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
