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
