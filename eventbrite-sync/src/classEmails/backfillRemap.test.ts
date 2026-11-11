// The volunteer backfill (scripts/backfill-volunteers.mjs) moves volunteer registrations to new
// Volunteers items, so both D1 ledgers name item ids that no longer hold the roster. This runs the
// script's remap SQL against the real schema and checks the class-email planner afterwards: an
// address already thanked under the old registration id must not be offered again under the new one.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, it, expect, vi } from 'vitest';
// @ts-expect-error -- a plain .mjs script module, no type declarations
import { remapSql } from '../../scripts/backfill-volunteers-lib.mjs';
import { D1AttendeeStore } from '../db/attendees';
import { D1ClassEmailStore } from '../db/classEmails';
import type { MondayClient, MondayItemColumns } from '../monday/client';
import { mondayItem } from '../test/mondayItem';
import { testConfig } from '../test/testConfig';
import { loadRoster } from './roster';
import { planKind } from './plan';

const config = testConfig();
const vc = config.attendeeSync.volunteers;
const facts = { startsAt: '2026-11-01T17:00:00.000Z', endsAt: '2026-11-01T19:00:00.000Z', eventbriteStatus: 'ended', audienceRole: 'Volunteer' as const };
const now = new Date('2026-11-05T12:00:00.000Z');
const moves = [
  { attendeeId: 'a1', oldItemId: '100', newItemId: '200' },
  { attendeeId: 'a2', oldItemId: '101', newItemId: '201' },
];

// The Volunteers board after the backfill: only the new items. The old registration ids are on
// another board (and archived), so a getItems on the Volunteers board never returns them.
const volunteers = new Map<string, MondayItemColumns>([
  ['200', mondayItem('200', 'Ann Lee', { [vc.statusColumn]: 'Completed', [vc.attendeeEmailColumn]: 'ann@v.org', [vc.attendeeNameColumn]: 'Ann Lee' })],
  ['201', mondayItem('201', 'Bo Park', { [vc.statusColumn]: 'Completed', [vc.attendeeEmailColumn]: 'bo@v.org', [vc.attendeeNameColumn]: 'Bo Park' })],
]);
const mondayClient = {
  getItems: vi.fn(async (_board: number, ids: string[]) => ids.flatMap((id) => volunteers.get(id) ?? [])),
} as unknown as MondayClient;

async function exec(sql: string): Promise<void> {
  const statements = sql.split('\n').filter((l) => l.trim() !== '');
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}

async function thankYouPlan() {
  const attendeeStore = new D1AttendeeStore(env.DB);
  const roster = await loadRoster('e1', { attendeeStore, mondayClient, config }, 'Volunteer');
  const ledger = await new D1ClassEmailStore(env.DB).listByEvent('e1');
  return planKind('thank-you', facts, roster, ledger, now);
}

describe('volunteer backfill remap and the class-email ledger', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM attendees');
    await env.DB.exec('DELETE FROM class_email_recipients');
    // Before the backfill: both attendees point at their Event Registrations items, and Ann's
    // thank-you went out under her registration id.
    for (const [attendeeId, itemId, at] of [['a1', '100', '2026-10-01T00:00:00.000Z'], ['a2', '101', '2026-10-02T00:00:00.000Z']]) {
      await env.DB.prepare(
        "INSERT INTO attendees (attendee_id, event_id, monday_item_id, status, last_action, received_at) VALUES (?1, 'e1', ?2, 'written', 'attendee.updated', ?3)"
      ).bind(attendeeId, itemId, at).run();
    }
    const store = new D1ClassEmailStore(env.DB);
    await store.claim('e1', 'thank-you', ['100'], '2026-11-02T00:00:00.000Z');
    await store.resolve('e1', 'thank-you', '100', 'sent', '2026-11-02T00:00:01.000Z');
  });

  it('after the remap, does not re-offer an address already sent', async () => {
    await exec(remapSql(moves));
    const plan = await thankYouPlan();
    expect(plan.refusal).toBeNull();
    expect(plan.recipients.map((r) => r.registrationId)).toEqual(['201']);
    expect(plan.recipients.map((r) => r.email)).not.toContain('ann@v.org');
    expect(plan.sent).toBe(1);
    expect(plan.unresolved).toEqual([]);
  });

  it('control: remapping only the attendee ledger would email Ann twice', async () => {
    const attendeesOnly = remapSql(moves).split('\n').filter((l: string) => l.startsWith('UPDATE attendees')).join('\n');
    await exec(attendeesOnly);
    const plan = await thankYouPlan();
    expect(plan.recipients.map((r) => r.registrationId)).toEqual(['200', '201']);
  });
});

// One attendee registered twice (old ids 100 and 102) moves onto one Volunteers item (200), and both
// registrations hold a claim for the same (event, kind): the primary key allows only one under 200.
describe('remap of a duplicate attendee onto one item', () => {
  const dupMoves = [
    { attendeeId: 'a1', oldItemId: '100', newItemId: '200' },
    { attendeeId: 'a1', oldItemId: '102', newItemId: '200' },
  ];
  const rows = async () => (await new D1ClassEmailStore(env.DB).listByEvent('e1'))
    .map((r) => [r.kind, r.registrationId, r.status, r.claimedAt, r.resolvedAt])
    .sort((x, y) => String(x).localeCompare(String(y)));

  async function seed(claims: [string, string, 'claimed' | 'sent' | 'failed'][]) {
    await env.DB.exec('DELETE FROM attendees');
    await env.DB.exec('DELETE FROM class_email_recipients');
    for (const [kind, id, status] of claims) {
      await env.DB.prepare(
        "INSERT INTO class_email_recipients (event_id, kind, registration_item_id, status, claimed_at, resolved_at) VALUES ('e1', ?1, ?2, ?3, ?4, ?5)"
      ).bind(kind, id, status, `claimed-${id}`, status === 'claimed' ? null : `resolved-${id}`).run();
    }
  }

  it('keeps the sent record when the leftover is the one that was sent', async () => {
    await seed([['thank-you', '100', 'failed'], ['thank-you', '102', 'sent']]);
    await exec(remapSql(dupMoves));
    expect(await rows()).toEqual([['thank-you', '200', 'sent', 'claimed-102', 'resolved-102']]);
  });

  it('keeps the sent record when it moved first, and never downgrades it', async () => {
    await seed([['thank-you', '100', 'sent'], ['thank-you', '102', 'claimed']]);
    await exec(remapSql(dupMoves));
    expect(await rows()).toEqual([['thank-you', '200', 'sent', 'claimed-100', 'resolved-100']]);
  });

  it('prefers claimed over failed, and leaves other kinds alone', async () => {
    await seed([['missed-you', '100', 'failed'], ['missed-you', '102', 'claimed'], ['reminder', '102', 'sent']]);
    await exec(remapSql(dupMoves));
    expect(await rows()).toEqual([
      ['missed-you', '200', 'claimed', 'claimed-102', null],
      ['reminder', '200', 'sent', 'claimed-102', 'resolved-102'],
    ]);
  });

  it('is idempotent: running the same SQL twice changes nothing more', async () => {
    await seed([['thank-you', '100', 'failed'], ['thank-you', '102', 'sent'], ['reminder', '100', 'sent']]);
    await exec(remapSql(dupMoves));
    const once = await rows();
    await exec(remapSql(dupMoves));
    expect(await rows()).toEqual(once);
    expect(once).toEqual([['reminder', '200', 'sent', 'claimed-100', 'resolved-100'], ['thank-you', '200', 'sent', 'claimed-102', 'resolved-102']]);
  });

  it('is safe to stop part way: re-running the whole file after any prefix ends the same', async () => {
    const sql = remapSql(dupMoves).split('\n').filter((l: string) => l.trim() !== '');
    await seed([['thank-you', '100', 'failed'], ['thank-you', '102', 'sent']]);
    await exec(sql.join('\n'));
    const expected = await rows();
    for (let k = 1; k < sql.length; k++) {
      await seed([['thank-you', '100', 'failed'], ['thank-you', '102', 'sent']]);
      await exec(sql.slice(0, k).join('\n'));
      await exec(sql.join('\n'));
      expect(await rows()).toEqual(expected);
    }
  });
});
