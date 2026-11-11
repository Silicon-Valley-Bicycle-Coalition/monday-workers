#!/usr/bin/env node
// Moves volunteer sign-ups already on the Event Registrations board (Role = Volunteer) onto the
// Volunteers board, where the Worker now writes them: one Volunteers item per attendee, with Event
// and Eventbrite Listing both pointing at the registration's Events item, Job and Date from that
// item, Status from Attendance, the Volunteer (People) link, attendee id, name and email copied over,
// and Historical unchecked. A one-off for the cutover
// (docs/superpowers/specs/2026-11-11-volunteers-board-eventbrite-design.md, "Backfill").
//
// Idempotent on Eventbrite Attendee ID: an attendee already on the Volunteers board (or in the
// resume ledger, data/backfill-volunteers-<env>.jsonl, gitignored) is never created again.
// Registrations with no attendee id, or whose listing isn't a volunteer-program event, are skipped
// and listed, never guessed at. Prints counts and item ids only, never names or addresses.
//
// Both D1 ledgers still name the OLD registration item ids afterwards (attendees.monday_item_id and
// class_email_recipients.registration_item_id). --remap-out writes the SQL that repoints them; run it
// before the Worker's write switch goes back on, or class emails and the consumer read the wrong board.
//
// Usage (from eventbrite-sync/):
//   MONDAY_API_TOKEN=... node scripts/backfill-volunteers.mjs                 dry run: plan + report
//   MONDAY_API_TOKEN=... node scripts/backfill-volunteers.mjs --apply         create the items
//   MONDAY_API_TOKEN=... node scripts/backfill-volunteers.mjs --remap-out data/remap.sql
//   npx wrangler d1 execute <db> --remote --file data/remap.sql [--env sandbox]
//   MONDAY_API_TOKEN=... node scripts/backfill-volunteers.mjs --archive --remap-out data/remap.sql
//     [--env sandbox]    use config/sandbox.json (the token must reach that workspace)
//     [--limit 50]       stop after this many creates
//     [--pause-ms 100]   wait between writes
// --archive archives (never deletes) the moved registrations, and only when every eligible attendee
// is on the Volunteers board; otherwise it archives nothing and exits 1. It also needs --remap-out in
// the same run, and records every move in the ledger first: archived registrations drop out of the
// board read, so the ledger is what lets a later --remap-out regenerate the SQL.

import { fileURLToPath } from 'node:url';
import { MondayGraphQL } from '../src/monday/graphql.ts';
import { readArg } from './backfill-orders-lib.mjs';
import {
  DEFAULT_VOLUNTEER_PROGRAMS, duplicateMoves, isoDate, ledgerLine, ledgerMoves, mergeMoves, parseLedger, planBackfill, reconcile, remapSql,
  statusLabel, volunteerColumnValues,
} from './backfill-volunteers-lib.mjs';

const PLACEHOLDER_COLUMN_ID = 'REPLACE_WITH_COLUMN_ID';
const SKIP_REASONS = ['no-attendee-id', 'not-a-volunteering-event', 'already-moved'];

// Paginates a board's items with the given column fields.
async function readBoard(client, boardId, columnIds) {
  const fields = `cursor items { id name column_values(ids: ${JSON.stringify(columnIds)}) { id text value ... on BoardRelationValue { linked_item_ids } } }`;
  const items = [];
  let cursor = null;
  do {
    const page = cursor
      ? (await client.request(`query ($c: String!) { next_items_page(cursor: $c, limit: 500) { ${fields} } }`, { c: cursor })).next_items_page
      : (await client.request(`query ($board: ID!) { boards(ids: [$board]) { items_page(limit: 500) { ${fields} } } }`, { board: boardId })).boards[0].items_page;
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

const cell = (item, id) => item.column_values.find((c) => c.id === id) ?? { text: '', value: null, linked_item_ids: [] };
const cellText = (item, id) => (cell(item, id).text ?? '').trim();
const linked = (item, id) => (cell(item, id).linked_item_ids ?? []).map(String);

async function readRegistrations(client, boardId, rc) {
  const items = await readBoard(client, boardId, [
    rc.attendeeIdColumn, rc.roleColumn, rc.attendanceColumn, rc.eventLinkColumn, rc.attendeeLinkColumn, rc.attendeeNameColumn, rc.attendeeEmailColumn,
  ]);
  return items.map((item) => {
    const role = cell(item, rc.roleColumn);
    const attendance = cell(item, rc.attendanceColumn);
    return {
      itemId: String(item.id),
      attendeeId: cellText(item, rc.attendeeIdColumn) || null,
      role: statusLabel(role.text, role.value),
      attendance: statusLabel(attendance.text, attendance.value),
      eventItemId: linked(item, rc.eventLinkColumn)[0] ?? null,
      personItemId: linked(item, rc.attendeeLinkColumn)[0] ?? null,
      // The column only: a nameless registration's item name is the placeholder "Eventbrite attendee <id>".
      name: cellText(item, rc.attendeeNameColumn) || null,
      email: cellText(item, rc.attendeeEmailColumn) || null,
    };
  });
}

async function readListings(client, eventItemIds, ec) {
  const listings = new Map();
  for (let i = 0; i < eventItemIds.length; i += 100) {
    const ids = eventItemIds.slice(i, i + 100);
    const data = await client.request(
      `query ($ids: [ID!]) { items(ids: $ids, limit: 100) { id name column_values(ids: ${JSON.stringify([ec.dateColumn, ec.programColumn])}) { id text value } } }`,
      { ids },
    );
    for (const item of data.items) {
      const program = cell(item, ec.programColumn);
      listings.set(String(item.id), { name: item.name, date: isoDate(cellText(item, ec.dateColumn)), program: statusLabel(program.text, program.value) });
    }
  }
  return listings;
}

async function readVolunteerIds(client, boardId, attendeeIdColumn) {
  const byAttendee = new Map();
  for (const item of await readBoard(client, boardId, [attendeeIdColumn])) {
    const attendeeId = cellText(item, attendeeIdColumn);
    if (attendeeId !== '' && !byAttendee.has(attendeeId)) byAttendee.set(attendeeId, String(item.id));
  }
  return byAttendee;
}

// A failure's kind, never its message: Monday can echo column values (names, addresses) back.
const failure = (err) => `${err?.name ?? 'Error'}${err?.code ? ` (${err.code})` : ''}${err?.httpStatus ? ` HTTP ${err.httpStatus}` : ''}`;

const idList = (ids) => (ids.length === 0 ? '' : `: ${ids.join(', ')}`);

/**
 * The whole backfill against an injected Monday client and I/O, so tests can drive it with fakes.
 * io: { log(line), readLedger(): string, appendLedger(line), writeFile(path, text), sleep(ms) }.
 * Returns the process exit code.
 */
export async function run({ argv, config, client, io }) {
  const { log } = io;
  let apply, archive, limit, pauseMs, remapOut;
  try {
    apply = argv.includes('--apply');
    archive = argv.includes('--archive');
    limit = Number(readArg(argv, '--limit', Infinity));
    pauseMs = Number(readArg(argv, '--pause-ms', 100));
    remapOut = readArg(argv, '--remap-out', null);
  } catch (err) {
    log(`backfill-volunteers: ${err.message}`);
    return 1;
  }
  if (archive && remapOut === null) {
    log('backfill-volunteers: --archive needs --remap-out <file> in the same run, so the D1 remap is written before the originals leave the board');
    return 1;
  }

  const { 'event-registrations': registrationsBoard, volunteers: volunteersBoard } = config.monday.boards;
  const rc = config.attendeeSync.registrations;
  const vc = config.attendeeSync.volunteers;
  const programs = config.attendeeSync.volunteerPrograms ?? DEFAULT_VOLUNTEER_PROGRAMS;
  if (volunteersBoard === null || registrationsBoard === null) {
    log('backfill-volunteers: monday.boards.volunteers and "event-registrations" must both be configured');
    return 1;
  }
  const placeholders = Object.entries(vc).filter(([, id]) => id === PLACEHOLDER_COLUMN_ID).map(([key]) => key);
  if (placeholders.length > 0) {
    log(`backfill-volunteers: attendeeSync.volunteers has placeholder column ids (${placeholders.join(', ')}); run setup-volunteers-board.mjs first`);
    return 1;
  }

  const registrations = await readRegistrations(client, registrationsBoard, rc);
  const eventItemIds = [...new Set(registrations.filter((r) => r.role === 'Volunteer' && r.eventItemId !== null).map((r) => r.eventItemId))];
  const listings = await readListings(client, eventItemIds, config.attendeeSync.events);
  const ledger = parseLedger(io.readLedger());
  const onBoard = async () => new Map([...ledger, ...(await readVolunteerIds(client, volunteersBoard, vc.attendeeIdColumn))]);

  const plan = planBackfill(registrations, listings, new Set((await onBoard()).keys()), programs);
  const volunteerRegs = registrations.filter((r) => r.role === 'Volunteer').length;
  log(`volunteer registrations ${volunteerRegs}; to create ${plan.create.length}`);
  for (const reason of SKIP_REASONS) {
    const ids = plan.skipped.filter((s) => s.reason === reason).map((s) => s.itemId);
    log(`skipped ${reason} ${ids.length}${reason === 'already-moved' ? '' : idList(ids)}`);
  }
  const unlinked = plan.create.filter((p) => p.personItemId === null).map((p) => p.registrationItemId);
  log(`${apply ? 'creating' : 'would create'} without a People link ${unlinked.length}${idList(unlinked)}`);

  let failed = 0;
  if (apply) {
    let created = 0;
    for (const p of plan.create.slice(0, limit)) {
      try {
        const data = await client.request(
          `mutation ($board: ID!, $name: String!, $values: JSON!) { create_item(board_id: $board, item_name: $name, column_values: $values) { id } }`,
          { board: volunteersBoard, name: p.itemName, values: JSON.stringify(volunteerColumnValues(p, vc)) },
          { idempotent: false },
        );
        const volunteerItemId = String(data.create_item.id);
        io.appendLedger(ledgerLine({ attendeeId: p.attendeeId, registrationItemId: p.registrationItemId, volunteerItemId }));
        ledger.set(p.attendeeId, volunteerItemId);
        created++;
      } catch (err) {
        // An ambiguous create may have landed: the re-run finds it on the board by attendee id.
        failed++;
        log(`registration ${p.registrationItemId} failed: ${failure(err)}`);
      }
      if ((created + failed) % 100 === 0) log(`created ${created}, failed ${failed}`);
      await io.sleep(pauseMs);
    }
    log(`created ${created}, failed ${failed}${created + failed < plan.create.length ? `; ${plan.create.length - created - failed} left for the next run` : ''}`);
  }

  if (remapOut !== null || archive) {
    const r = reconcile(registrations, listings, await onBoard(), programs);
    log(`count check: eligible attendees ${r.eligible}, on the Volunteers board ${r.present}${r.missing.length > 0 ? `; registrations not yet moved${idList(r.missing)}` : ''}`);
    const recorded = ledgerMoves(io.readLedger());
    const moves = mergeMoves(r.moves, recorded);
    for (const { newItemId, oldItemIds } of duplicateMoves(moves)) {
      log(`duplicate attendee: volunteer ${newItemId} takes registrations ${oldItemIds.join(', ')} (class-email claims merged, highest status kept)`);
    }
    if (remapOut !== null) {
      io.writeFile(remapOut, remapSql(moves));
      log(`wrote ${moves.length} ledger remaps to ${remapOut}; apply with: npx wrangler d1 execute <db> --remote --file ${remapOut}`);
    }
    if (archive) {
      if (!r.ok) {
        log('count check failed: nothing archived. Re-run --apply until every eligible registration is moved.');
        return 1;
      }
      // Every move into the ledger before any original is archived, so the remap stays reproducible.
      const inLedger = new Set(recorded.map((m) => m.oldItemId));
      for (const m of r.moves) {
        if (!inLedger.has(m.oldItemId)) io.appendLedger(ledgerLine({ attendeeId: m.attendeeId, registrationItemId: m.oldItemId, volunteerItemId: m.newItemId }));
      }
      let archived = 0;
      for (const itemId of r.toArchive) {
        try {
          await client.request(`mutation ($item: ID!) { archive_item(item_id: $item) { id } }`, { item: itemId });
          archived++;
        } catch (err) {
          failed++;
          log(`archive ${itemId} failed: ${failure(err)}`);
        }
        await io.sleep(pauseMs);
      }
      log(`archived ${archived} of ${r.toArchive.length} registrations`);
    }
  }
  return failed > 0 ? 1 : 0;
}

async function main() {
  const { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    console.error('backfill-volunteers: MONDAY_API_TOKEN is required');
    process.exit(1);
  }
  const env = readArg(process.argv, '--env', null) === 'sandbox' ? 'sandbox' : 'production';
  const config = JSON.parse(readFileSync(join(here, '..', 'config', env === 'sandbox' ? 'sandbox.json' : 'svbc.json'), 'utf8'));
  // data/ is gitignored repo-wide: the ledger holds only ids, but never commit it.
  const dataDir = join(here, '..', 'data');
  const ledgerPath = join(dataDir, `backfill-volunteers-${env}.jsonl`);
  const io = {
    log: (m) => console.log(`${new Date().toISOString()} ${m}`),
    readLedger: () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : ''),
    appendLedger: (line) => {
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(ledgerPath, line);
    },
    writeFile: (path, body) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const client = new MondayGraphQL(config.monday.apiUrl ?? 'https://api.monday.com/v2', token);
  process.exit(await run({ argv: process.argv.slice(2), config, client, io }));
}

// The repo's entry-point idiom, not Node's newer main-module flag, which some type-stripping Node versions lack.
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
