import { describe, it, expect } from 'vitest';
import { run } from './backfill-volunteers.mjs';
import { testConfig } from '../src/test/testConfig';

const config = testConfig();
const rc = config.attendeeSync.registrations;
const ec = config.attendeeSync.events;
const vc = config.attendeeSync.volunteers;
const { 'event-registrations': REG_BOARD, volunteers: VOL_BOARD } = config.monday.boards;

const status = (id, label) => ({ id, text: label, value: label === '' ? null : JSON.stringify({ index: 1 }) });
const text = (id, t) => ({ id, text: t, value: t === '' ? null : JSON.stringify(t) });
const rel = (id, ids) => ({ id, text: '', value: null, linked_item_ids: ids });

function registration(id, { attendeeId = `a${id}`, role = 'Volunteer', attendance = 'Registered', event = '900', person = null } = {}) {
  return {
    id, name: `Secret Name ${id}`,
    column_values: [
      text(rc.attendeeIdColumn, attendeeId), status(rc.roleColumn, role), status(rc.attendanceColumn, attendance),
      rel(rc.eventLinkColumn, event === null ? [] : [event]), rel(rc.attendeeLinkColumn, person === null ? [] : [person]),
      text(rc.attendeeNameColumn, `Secret Name ${id}`), text(rc.attendeeEmailColumn, `secret${id}@v.org`),
    ],
  };
}

const events = {
  900: { id: '900', name: 'Trail Work Day', column_values: [text(ec.dateColumn, '2026-10-30'), status(ec.programColumn, 'Volunteering')] },
  901: { id: '901', name: 'Bike Class', column_values: [text(ec.dateColumn, '2026-10-31'), status(ec.programColumn, 'Public')] },
};

// A fake Monday: routes each GraphQL request by what it asks for, and records every write.
function fakeMonday(registrations, volunteers = []) {
  const state = { registrations, volunteers: [...volunteers], created: [], archived: [], nextId: 5000, failCreateFor: new Set() };
  const page = (items) => ({ cursor: null, items });
  state.client = {
    async request(query, vars) {
      if (query.includes('create_item')) {
        const values = JSON.parse(vars.values);
        if (state.failCreateFor.has(values[vc.attendeeIdColumn])) throw Object.assign(new Error('boom'), { name: 'MondayApiError', code: 'X' });
        const id = String(state.nextId++);
        state.created.push({ board: vars.board, name: vars.name, values });
        state.volunteers.push({ id, column_values: [text(vc.attendeeIdColumn, values[vc.attendeeIdColumn])] });
        return { create_item: { id } };
      }
      if (query.includes('archive_item')) {
        state.archived.push(String(vars.item));
        return { archive_item: { id: vars.item } };
      }
      if (query.includes('items(ids:')) return { items: vars.ids.map((id) => events[id]).filter(Boolean) };
      if (query.includes('boards(ids:')) {
        if (String(vars.board) === String(REG_BOARD)) return { boards: [{ items_page: page(state.registrations) }] };
        if (String(vars.board) === String(VOL_BOARD)) return { boards: [{ items_page: page(state.volunteers) }] };
      }
      throw new Error(`fake Monday: unexpected request ${query.slice(0, 60)}`);
    },
  };
  return state;
}

function io() {
  const out = { lines: [], ledger: '', files: {} };
  out.io = {
    log: (m) => out.lines.push(m),
    readLedger: () => out.ledger,
    appendLedger: (line) => { out.ledger += line; },
    writeFile: (path, body) => { out.files[path] = body; },
    sleep: async () => {},
  };
  out.text = () => out.lines.join('\n');
  return out;
}

const regs = () => [
  registration('1', { person: '77', attendance: 'Attended' }),
  registration('2', { attendance: 'No Show' }),
  registration('3', { attendeeId: '' }),
  registration('4', { event: '901' }),
  registration('5', { role: 'Participant' }),
];

describe('backfill-volunteers CLI', () => {
  it('dry-runs by default: reports counts and ids, writes nothing, prints no names or addresses', async () => {
    const m = fakeMonday(regs());
    const o = io();
    expect(await run({ argv: [], config, client: m.client, io: o.io })).toBe(0);
    expect(m.created).toEqual([]);
    expect(m.archived).toEqual([]);
    expect(o.text()).toContain('to create 2');
    expect(o.text()).toContain('no-attendee-id 1: 3');
    expect(o.text()).toContain('not-a-volunteering-event 1: 4');
    expect(o.text()).toContain('without a People link 1');
    expect(o.text()).not.toMatch(/Secret|secret|@/);
  });

  it('--apply creates each item with both relations, records it in the ledger, and a re-run creates nothing', async () => {
    const m = fakeMonday(regs());
    const o = io();
    expect(await run({ argv: ['--apply'], config, client: m.client, io: o.io })).toBe(0);
    expect(m.created).toHaveLength(2);
    expect(m.created[0]).toMatchObject({ board: VOL_BOARD, name: 'Secret Name 1' });
    expect(m.created[0].values).toMatchObject({
      [vc.attendeeIdColumn]: 'a1', [vc.statusColumn]: 'Completed', [vc.jobColumn]: 'Trail Work Day',
      [vc.dateColumn]: { date: '2026-10-30' }, [vc.historicalColumn]: { checked: 'false' },
      [vc.eventColumn]: { item_ids: [900] }, [vc.listingColumn]: { item_ids: [900] }, [vc.volunteerLinkColumn]: { item_ids: [77] },
    });
    expect(m.created[1].values[vc.statusColumn]).toBe('No-Show');
    expect(o.ledger.trim().split('\n')).toHaveLength(2);
    expect(o.text()).not.toMatch(/Secret|secret|@/);

    await run({ argv: ['--apply'], config, client: m.client, io: o.io });
    expect(m.created).toHaveLength(2);
  });

  it('resumes from the ledger even when the board read misses an item it already created', async () => {
    const m = fakeMonday(regs());
    const o = io();
    await run({ argv: ['--apply'], config, client: m.client, io: o.io });
    m.volunteers.length = 0; // the board read lags behind the creates
    await run({ argv: ['--apply'], config, client: m.client, io: o.io });
    expect(m.created).toHaveLength(2);
  });

  it('--limit stops after that many creates', async () => {
    const m = fakeMonday(regs());
    await run({ argv: ['--apply', '--limit', '1'], config, client: m.client, io: io().io });
    expect(m.created).toHaveLength(1);
  });

  it('--remap-out writes the SQL for every moved registration', async () => {
    const m = fakeMonday(regs());
    const o = io();
    await run({ argv: ['--apply', '--remap-out', 'data/remap.sql'], config, client: m.client, io: o.io });
    const sql = o.files['data/remap.sql'];
    expect(sql).toContain("UPDATE attendees SET monday_item_id = '5000' WHERE attendee_id = 'a1';");
    expect(sql).toContain("UPDATE class_email_recipients SET registration_item_id = '5001' WHERE registration_item_id = '2';");
  });

  it('--archive refuses when the count check fails, and archives nothing', async () => {
    const m = fakeMonday(regs());
    m.failCreateFor.add('a2');
    const o = io();
    expect(await run({ argv: ['--apply', '--archive'], config, client: m.client, io: o.io })).toBe(1);
    expect(m.created).toHaveLength(1);
    expect(m.archived).toEqual([]);
    expect(o.text()).toContain('count check failed');
    expect(o.text()).not.toMatch(/Secret|secret|@|boom/);
  });

  it('--archive archives only the moved originals once the count check passes', async () => {
    const m = fakeMonday(regs());
    const o = io();
    expect(await run({ argv: ['--apply', '--archive'], config, client: m.client, io: o.io })).toBe(0);
    expect(m.archived).toEqual(['1', '2']);
  });

  it('refuses when the Volunteers board or its attendee id column is not configured', async () => {
    const noBoard = testConfig({}, { volunteers: null });
    const o = io();
    expect(await run({ argv: [], config: noBoard, client: fakeMonday([]).client, io: o.io })).toBe(1);
    const placeholder = testConfig();
    placeholder.attendeeSync.volunteers.attendeeIdColumn = 'REPLACE_WITH_COLUMN_ID';
    expect(await run({ argv: [], config: placeholder, client: fakeMonday([]).client, io: o.io })).toBe(1);
  });
});
