import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { registerClassEmailRoutes } from './routes';
import type { ClassEmailRow } from '../db/classEmails';
import type { MondayClient, MondayItemColumns } from '../monday/client';
import type { WriteMode } from '../flags';
import type { AttendeeRow, EventRow } from '../types';
import { fakeAttendeeStore, fakeClassEmailStore, fakeEventStore } from '../test/fakeStores';
import { mondayItem } from '../test/mondayItem';
import { testConfig } from '../test/testConfig';

const SECRET = 'class-secret';
const NOW = new Date('2026-11-10T12:00:00.000Z');
const rc = testConfig().attendeeSync.registrations;

// Ends before NOW: thank-you and missed-you are open, the reminder is refused.
const PAST = { startsAt: '2026-11-05T17:00:00.000Z', endsAt: '2026-11-05T19:00:00.000Z' };
const UPCOMING = { startsAt: '2026-11-12T17:00:00.000Z', endsAt: '2026-11-12T19:00:00.000Z' };

function eventRow(over: Partial<EventRow> = {}): EventRow {
  return { eventId: 'e1', mondayItemId: '900', ...UPCOMING, locationKey: null, eventbriteStatus: 'live', status: 'written', lastAction: 'event.updated', error: null, deliveries: 1, receivedAt: '2026-11-01T00:00:00.000Z', writtenAt: null, ...over };
}

function attendee(attendeeId: string, mondayItemId: string | null, eventId = 'e1'): AttendeeRow {
  return { attendeeId, eventId, mondayItemId, matchedPersonItemId: null, status: 'written', lastAction: 'attendee.updated', error: null, deliveries: 1, receivedAt: '2026-11-01T00:00:00.000Z', writtenAt: null } as AttendeeRow;
}

const NAMES: Record<string, string> = { '10': 'Al One', '11': 'Bo Two', '12': 'Cy Three', '13': 'Di Four' };
function reg(id: string, over: Record<string, string> = {}): MondayItemColumns {
  return mondayItem(id, NAMES[id] ?? `Person ${id}`, {
    [rc.attendanceColumn]: 'Registered', [rc.roleColumn]: 'Participant', [rc.attendeeEmailColumn]: `p${id}@real.org`,
    [rc.firstNameColumn]: `F${id}`, [rc.attendeeLinkColumn]: '', ...over,
  });
}

function row(kind: ClassEmailRow['kind'], registrationId: string, status: ClassEmailRow['status'] = 'claimed', eventId = 'e1'): ClassEmailRow {
  return { eventId, kind, registrationId, status, claimedAt: '2026-11-10T11:00:00.000Z', resolvedAt: null };
}

interface Options {
  event?: Partial<EventRow> | null;
  items?: MondayItemColumns[];
  ledger?: ClassEmailRow[];
  mode?: WriteMode;
  sandbox?: string | null;
  secret?: string | undefined;
  peopleLookup?: () => Promise<{ id: string } | null>;
  postUpdate?: () => Promise<void>;
}

function harness(o: Options = {}) {
  const config = testConfig();
  config.attendeeSync.classEmails.sandboxRecipient = o.sandbox ?? null;
  const items = new Map<string, MondayItemColumns>();
  for (const i of [mondayItem('900', 'Learn to Ride', {}), ...(o.items ?? [reg('10'), reg('11')])]) items.set(i.id, i);
  const client = {
    getItems: vi.fn(async (_board: number, ids: string[]) => ids.flatMap((id) => (items.has(id) ? [items.get(id)!] : []))),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    findItemByColumnValue: vi.fn(o.peopleLookup ?? (async () => ({ id: '50' }))),
    createItem: vi.fn().mockResolvedValue({ id: '51' }),
    postUpdate: vi.fn(o.postUpdate ?? (async () => undefined)),
    notify: vi.fn(),
  };
  const mondayClient = vi.fn(() => client as unknown as MondayClient);
  const store = fakeClassEmailStore(o.ledger ?? []);
  const eventStore = fakeEventStore({ getEvent: vi.fn(async (id: string) => (o.event === null || id !== 'e1' ? null : eventRow(o.event))) });
  const attendeeStore = fakeAttendeeStore({
    listByEvent: vi.fn(async (eventId: string) => (eventId === 'e1' ? [...items.keys()].filter((k) => k !== '900').map((k) => attendee(`a${k}`, k)) : [attendee('zz', '99', eventId)])),
  });
  const app = new Hono();
  registerClassEmailRoutes(app, {
    store, mondayClient, secret: 'secret' in o ? o.secret : SECRET, eventStore, attendeeStore, config,
    writeMode: async () => o.mode ?? 'on', now: () => NOW,
  });
  return { app, client, mondayClient, store, items, eventStore, attendeeStore };
}

type App = ReturnType<typeof harness>['app'];
function call(app: App, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = { 'X-Class-Email-Secret': SECRET }) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}
const get = (h: { app: App }, eventId = 'e1') => call(h.app, 'GET', `/class-emails/${eventId}`);
const post = (h: { app: App }, route: 'claim' | 'result' | 'release', body: unknown) => call(h.app, 'POST', `/class-emails/e1/${route}`, body);
const sendResult = (kind: string, results: unknown, over: Record<string, unknown> = {}) => ({ kind, sender: 'coach@svbc.org', subject: 'See you soon', results, ...over });

afterEach(() => vi.restoreAllMocks());

describe('authentication', () => {
  const routes: [string, string, unknown][] = [
    ['GET', '/class-emails/e1', undefined],
    ['POST', '/class-emails/e1/claim', { kind: 'reminder' }],
    ['POST', '/class-emails/e1/result', sendResult('reminder', [])],
    ['POST', '/class-emails/e1/release', { kind: 'reminder', sender: 'coach@svbc.org', registrationIds: [] }],
  ];

  it('rejects a missing or wrong secret on all four routes', async () => {
    const h = harness({ ledger: [row('reminder', '10')] });
    for (const [method, path, body] of routes) {
      for (const headers of [{}, { 'X-Class-Email-Secret': 'wrong' }, { 'X-Class-Email-Secret': '' }] as Record<string, string>[]) {
        const res = await call(h.app, method as 'GET' | 'POST', path, body, headers);
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    }
    expect(h.mondayClient).not.toHaveBeenCalled();
    expect(h.eventStore.getEvent).not.toHaveBeenCalled();
    expect(h.store.rows).toEqual([row('reminder', '10')]);
  });

  it('rejects every request when the secret is unset', async () => {
    for (const secret of [undefined, '']) {
      const h = harness({ secret });
      for (const [method, path, body] of routes) {
        for (const headers of [{}, { 'X-Class-Email-Secret': '' }, { 'X-Class-Email-Secret': 'anything' }] as Record<string, string>[]) {
          expect((await call(h.app, method as 'GET' | 'POST', path, body, headers)).status).toBe(401);
        }
      }
      expect(h.mondayClient).not.toHaveBeenCalled();
    }
  });
});

describe('GET /class-emails/:eventId', () => {
  it('returns all three kinds, and 404s an unknown event', async () => {
    const h = harness({ event: { ...PAST, eventbriteStatus: 'completed' }, items: [reg('10', { [rc.attendanceColumn]: 'Attended' }), reg('11')], ledger: [row('thank-you', '12', 'sent')] });
    const res = await get(h);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as any;
    expect(body.event).toEqual({ name: 'Learn to Ride', startsAt: PAST.startsAt, endsAt: PAST.endsAt, status: 'completed' });
    expect(body.writesOn).toBe(true);
    expect(Object.keys(body.kinds).sort()).toEqual(['missed-you', 'reminder', 'thank-you']);
    expect(body.kinds.reminder.refusal).toMatch(/already started/);
    expect(body.kinds['thank-you'].recipients.map((r: any) => r.registrationId)).toEqual(['10']);
    expect(body.kinds['thank-you'].sent).toBe(1);
    expect(body.kinds['missed-you'].recipients.map((r: any) => r.registrationId)).toEqual(['11']);

    expect((await get(h, 'nope')).status).toBe(404);
    expect(((await (await get(h, 'nope')).json()) as any).error).toEqual(expect.any(String));
    expect((await get(harness({ event: { mondayItemId: null } }))).status).toBe(404);
    expect((await get(harness({ event: null }))).status).toBe(404);
  });

  it('reports writesOn false and still serves the plan when writes are not on', async () => {
    const res = await get(harness({ mode: 'hold' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).writesOn).toBe(false);
  });

  it("never includes other events' registrations", async () => {
    const h = harness({ ledger: [row('reminder', '99', 'claimed', 'other'), row('reminder', '98', 'sent', 'other')] });
    const text = await (await get(h)).text();
    expect(h.attendeeStore.listByEvent).toHaveBeenCalledTimes(1);
    expect(h.attendeeStore.listByEvent).toHaveBeenCalledWith('e1');
    const body = JSON.parse(text);
    expect(body.kinds.reminder.sent).toBe(0);
    expect(body.kinds.reminder.unresolved).toEqual([]);
    expect(body.kinds.reminder.recipients.map((r: any) => r.registrationId)).toEqual(['10', '11']);
    expect(text).not.toContain('"99"');
    expect(text).not.toContain('"98"');
  });
});

describe('POST claim', () => {
  it('re-plans from live Monday data', async () => {
    const h = harness();
    const before = ((await (await get(h)).json()) as any).kinds.reminder.recipients;
    expect(before.map((r: any) => r.registrationId)).toEqual(['10', '11']);

    h.items.set('11', reg('11', { [rc.attendanceColumn]: 'Canceled' }));
    const res = await post(h, 'claim', { kind: 'reminder' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.refusal).toBeNull();
    expect(body.recipients).toEqual([{ registrationId: '10', email: 'p10@real.org', firstName: 'F10', name: 'Al One' }]);
    expect(h.store.rows.map((r) => [r.registrationId, r.status])).toEqual([['10', 'claimed']]);
  });

  it('claim refuses a canceled event', async () => {
    const h = harness({ event: { eventbriteStatus: 'canceled' } });
    const res = await post(h, 'claim', { kind: 'reminder' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.refusal).toMatch(/canceled/);
    expect(body.recipients).toEqual([]);
    expect(h.store.rows).toEqual([]);
  });

  it('refuses a reminder once the class has started, claiming nothing', async () => {
    const h = harness({ event: PAST });
    const body = (await (await post(h, 'claim', { kind: 'reminder' })).json()) as any;
    expect(body.refusal).toMatch(/already started/);
    expect(h.store.rows).toEqual([]);
  });

  it('a second claim returns no recipients', async () => {
    const h = harness();
    expect((((await (await post(h, 'claim', { kind: 'reminder' })).json()) as any).recipients as unknown[]).length).toBe(2);
    const second = (await (await post(h, 'claim', { kind: 'reminder' })).json()) as any;
    expect(second).toEqual({ refusal: null, recipients: [] });
  });

  it('returns only what the store says it newly claimed, when another claim wins a race', async () => {
    const h = harness();
    const claim = h.store.claim;
    h.store.claim = async (e, k, ids, at) => claim(e, k, ids.filter((id) => id !== '10'), at);
    const body = (await (await post(h, 'claim', { kind: 'reminder' })).json()) as any;
    expect(body.recipients.map((r: any) => r.registrationId)).toEqual(['11']);
  });

  it('claim returns 503 and records nothing unless writes are on', async () => {
    for (const mode of ['off', 'hold', 'unknown'] as const) {
      const h = harness({ mode });
      const res = await post(h, 'claim', { kind: 'reminder' });
      expect(res.status, mode).toBe(503);
      expect(((await res.json()) as any).error).toEqual(expect.any(String));
      expect(h.store.rows).toEqual([]);
      expect(h.mondayClient).not.toHaveBeenCalled();
    }
  });

  it('404s an unknown event', async () => {
    const h = harness({ event: null });
    expect((await post(h, 'claim', { kind: 'reminder' })).status).toBe(404);
  });
});

describe('POST result', () => {
  it('result marks rows, and ignores ids that were not claimed for this event and kind', async () => {
    const h = harness({
      items: [reg('10'), reg('11'), reg('12'), reg('13')],
      ledger: [row('reminder', '10'), row('reminder', '11'), row('thank-you', '12'), row('reminder', '13', 'claimed', 'other')],
    });
    const res = await post(h, 'result', sendResult('reminder', [
      { registrationId: '10', status: 'sent' },
      { registrationId: '11', status: 'failed', error: 'bounced' },
      { registrationId: '12', status: 'sent' },
      { registrationId: '13', status: 'sent' },
      { registrationId: '14', status: 'sent' },
    ]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: 1, failed: 1, unresolved: 1 });
    const state = h.store.rows.map((r) => `${r.eventId}/${r.kind}/${r.registrationId}=${r.status}`);
    expect(state).toEqual(['e1/reminder/10=sent', 'e1/reminder/11=failed', 'e1/thank-you/12=claimed', 'other/reminder/13=claimed']);
  });

  it('does not resolve a row that is already sent or failed', async () => {
    const h = harness({ ledger: [row('reminder', '10', 'sent'), row('reminder', '11', 'failed')] });
    const body = (await (await post(h, 'result', sendResult('reminder', [{ registrationId: '10', status: 'failed' }, { registrationId: '11', status: 'sent' }]))).json()) as any;
    expect(body).toMatchObject({ sent: 0, failed: 0 });
    expect(h.store.rows.map((r) => r.status)).toEqual(['sent', 'failed']);
    expect(h.client.postUpdate).not.toHaveBeenCalled();
  });

  it('result on a missed-you sets No Show only on confirmed rows still Registered', async () => {
    const h = harness({
      items: [reg('10'), reg('11', { [rc.attendanceColumn]: 'Attended' }), reg('12', { [rc.attendanceColumn]: 'No Show' }), reg('13')],
      ledger: [row('missed-you', '10'), row('missed-you', '11'), row('missed-you', '12'), row('missed-you', '13')],
    });
    await post(h, 'result', sendResult('missed-you', [
      { registrationId: '10', status: 'sent' },
      { registrationId: '11', status: 'sent' },
      { registrationId: '12', status: 'sent' },
      { registrationId: '13', status: 'failed', error: 'x' },
      { registrationId: '14', status: 'sent' },
    ]));
    expect(h.client.changeColumnValues).toHaveBeenCalledTimes(1);
    expect(h.client.changeColumnValues).toHaveBeenCalledWith(333, '10', { [rc.attendanceColumn]: 'No Show' });
    // Read fresh, once, for the sent ids that were claimed.
    expect(h.client.getItems).toHaveBeenCalledWith(333, ['10', '11', '12'], [rc.attendanceColumn]);
  });

  it('writes no Attendance for a reminder or a thank-you', async () => {
    const h = harness({ items: [reg('10', { [rc.attendanceColumn]: 'Attended', [rc.attendeeLinkColumn]: 'Al' })], ledger: [row('thank-you', '10'), row('reminder', '10')] });
    await post(h, 'result', sendResult('reminder', [{ registrationId: '10', status: 'sent' }]));
    await post(h, 'result', sendResult('thank-you', [{ registrationId: '10', status: 'sent' }]));
    expect(h.client.changeColumnValues).not.toHaveBeenCalled();
  });

  it('result on a thank-you links People when Attendee is blank, and never overwrites a link', async () => {
    const h = harness({
      items: [reg('10', { [rc.attendanceColumn]: 'Attended' }), reg('11', { [rc.attendanceColumn]: 'Attended', [rc.attendeeLinkColumn]: 'Existing Person' })],
      ledger: [row('thank-you', '10'), row('thank-you', '11')],
    });
    await post(h, 'result', sendResult('thank-you', [{ registrationId: '10', status: 'sent' }, { registrationId: '11', status: 'sent' }]));
    expect(h.client.findItemByColumnValue).toHaveBeenCalledTimes(1);
    expect(h.client.findItemByColumnValue).toHaveBeenCalledWith(42, 'people_email_col', 'p10@real.org');
    expect(h.client.changeColumnValues).toHaveBeenCalledTimes(1);
    expect(h.client.changeColumnValues).toHaveBeenCalledWith(333, '10', { [rc.attendeeLinkColumn]: { item_ids: [50] } });
  });

  it('does not link People for a failed thank-you', async () => {
    const h = harness({ items: [reg('10', { [rc.attendanceColumn]: 'Attended' })], ledger: [row('thank-you', '10')] });
    await post(h, 'result', sendResult('thank-you', [{ registrationId: '10', status: 'failed', error: 'x' }]));
    expect(h.client.findItemByColumnValue).not.toHaveBeenCalled();
    expect(h.client.changeColumnValues).not.toHaveBeenCalled();
  });

  it("a People match failure doesn't lose the result", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({
      items: [reg('10', { [rc.attendanceColumn]: 'Attended' }), reg('11', { [rc.attendanceColumn]: 'Attended' })],
      ledger: [row('thank-you', '10'), row('thank-you', '11')],
      peopleLookup: async () => { throw new Error('Monday refused p10@real.org'); },
    });
    const res = await post(h, 'result', sendResult('thank-you', [{ registrationId: '10', status: 'sent' }, { registrationId: '11', status: 'sent' }]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sent: 2 });
    expect(h.store.rows.map((r) => r.status)).toEqual(['sent', 'sent']);
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain('real.org');
    expect(h.client.postUpdate).toHaveBeenCalledTimes(1);
  });

  it('a Monday client that cannot be built does not lose the result', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ ledger: [row('reminder', '10')] });
    h.mondayClient.mockImplementation(() => { throw new Error('no MONDAY_AUTH'); });
    const res = await post(h, 'result', sendResult('reminder', [{ registrationId: '10', status: 'sent' }]));
    expect(res.status).toBe(200);
    expect(h.store.rows[0]!.status).toBe('sent');
  });

  it('result posts one update with kind, sender, subject, counts and failed addresses', async () => {
    const h = harness({ items: [reg('10'), reg('11'), reg('12')], ledger: [row('reminder', '10'), row('reminder', '11'), row('reminder', '12')] });
    const long = 'x'.repeat(300);
    await post(h, 'result', sendResult('reminder', [
      { registrationId: '10', status: 'sent' },
      { registrationId: '11', status: 'failed', error: 'Invalid\nrecipient' },
      { registrationId: '12', status: 'failed', error: long },
    ]));
    expect(h.client.postUpdate).toHaveBeenCalledTimes(1);
    const [itemId, text] = h.client.postUpdate.mock.calls[0] as unknown as [string, string];
    expect(itemId).toBe('900');
    expect(text.split('\n')).toEqual([
      'Class email: Reminder, "See you soon". Sent by coach@svbc.org to 1 person.',
      'Failed: p11@real.org (Invalid recipient)',
      `Failed: p12@real.org (${'x'.repeat(200)})`,
    ]);
  });

  it('says "people" for a plural count and omits Failed lines when none failed', async () => {
    const h = harness({ ledger: [row('thank-you', '10'), row('thank-you', '11')] });
    await post(h, 'result', sendResult('thank-you', [{ registrationId: '10', status: 'sent' }, { registrationId: '11', status: 'sent' }], { subject: 'Thanks' }));
    expect(h.client.postUpdate).toHaveBeenCalledWith('900', 'Class email: Thank-you, "Thanks". Sent by coach@svbc.org to 2 people.');
  });

  it("a failed update post doesn't lose the result", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ ledger: [row('reminder', '10')], postUpdate: async () => { throw new Error('boom for p10@real.org'); } });
    const res = await post(h, 'result', sendResult('reminder', [{ registrationId: '10', status: 'sent' }]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sent: 1 });
    expect(h.store.rows[0]!.status).toBe('sent');
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain('real.org');
  });

  it('returns 503 and records nothing unless writes are on', async () => {
    for (const mode of ['off', 'hold', 'unknown'] as const) {
      const h = harness({ mode, ledger: [row('reminder', '10')] });
      const res = await post(h, 'result', sendResult('reminder', [{ registrationId: '10', status: 'sent' }]));
      expect(res.status, mode).toBe(503);
      expect(h.store.rows[0]!.status).toBe('claimed');
      expect(h.mondayClient).not.toHaveBeenCalled();
    }
  });

  it('404s an unknown event', async () => {
    expect((await post(harness({ event: null }), 'result', sendResult('reminder', []))).status).toBe(404);
  });
});

describe('POST release', () => {
  it('release frees rows and posts an update naming the sender', async () => {
    const h = harness({ ledger: [row('reminder', '10'), row('reminder', '11', 'failed'), row('reminder', '12', 'sent'), row('thank-you', '13')] });
    const res = await post(h, 'release', { kind: 'reminder', sender: 'coach@svbc.org', registrationIds: ['10', '11', '12', '14'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.store.rows.map((r) => `${r.kind}/${r.registrationId}=${r.status}`)).toEqual(['reminder/12=sent', 'thank-you/13=claimed']);
    expect(h.client.postUpdate).toHaveBeenCalledTimes(1);
    expect(h.client.postUpdate).toHaveBeenCalledWith('900', 'Class email: Reminder. coach@svbc.org released 2 people who were not confirmed sent, so they can be emailed again.');
  });

  it('posts no update when nothing was released, and survives a failed post', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const none = harness({ ledger: [row('reminder', '12', 'sent')] });
    expect((await post(none, 'release', { kind: 'reminder', sender: 'coach@svbc.org', registrationIds: ['12'] })).status).toBe(200);
    expect(none.client.postUpdate).not.toHaveBeenCalled();
    expect(none.store.rows).toHaveLength(1);

    const failing = harness({ ledger: [row('reminder', '10')], postUpdate: async () => { throw new Error('boom'); } });
    expect((await post(failing, 'release', { kind: 'reminder', sender: 'coach@svbc.org', registrationIds: ['10'] })).status).toBe(200);
    expect(failing.store.rows).toEqual([]);
  });

  it('returns 503 unless writes are on, and 404s an unknown event', async () => {
    const h = harness({ mode: 'off', ledger: [row('reminder', '10')] });
    expect((await post(h, 'release', { kind: 'reminder', sender: 'coach@svbc.org', registrationIds: ['10'] })).status).toBe(503);
    expect(h.store.rows).toHaveLength(1);
    expect((await post(harness({ event: null }), 'release', { kind: 'reminder', sender: 'coach@svbc.org', registrationIds: ['10'] })).status).toBe(404);
  });
});

describe('validation', () => {
  const ok = { registrationId: '10', status: 'sent' };
  const cases: [string, 'claim' | 'result' | 'release', unknown][] = [
    ['unknown kind on claim', 'claim', { kind: 'newsletter' }],
    ['missing kind on claim', 'claim', {}],
    ['non-object body', 'claim', [1]],
    ['unknown kind on result', 'result', sendResult('newsletter', [])],
    ['non-array results', 'result', sendResult('reminder', 'nope')],
    ['non-string sender', 'result', sendResult('reminder', [], { sender: 7 })],
    ['sender that is not an address', 'result', sendResult('reminder', [], { sender: 'coach' })],
    ['sender with a space', 'result', sendResult('reminder', [], { sender: 'a b@svbc.org' })],
    ['non-string subject', 'result', sendResult('reminder', [], { subject: null })],
    ['501 results', 'result', sendResult('reminder', Array.from({ length: 501 }, (_, i) => ({ registrationId: `${i}`, status: 'sent' })))],
    ['unknown result status', 'result', sendResult('reminder', [{ registrationId: '10', status: 'maybe' }])],
    ['non-string registrationId', 'result', sendResult('reminder', [{ registrationId: 10, status: 'sent' }])],
    ['non-string error', 'result', sendResult('reminder', [{ ...ok, status: 'failed', error: 4 }])],
    ['non-object result entry', 'result', sendResult('reminder', ['10'])],
    ['unknown kind on release', 'release', { kind: 'x', sender: 'coach@svbc.org', registrationIds: [] }],
    ['non-array registrationIds', 'release', { kind: 'reminder', sender: 'coach@svbc.org', registrationIds: '10' }],
    ['non-string registrationIds', 'release', { kind: 'reminder', sender: 'coach@svbc.org', registrationIds: [10] }],
    ['501 registrationIds', 'release', { kind: 'reminder', sender: 'coach@svbc.org', registrationIds: Array.from({ length: 501 }, (_, i) => `${i}`) }],
    ['release sender that is not an address', 'release', { kind: 'reminder', sender: 'x', registrationIds: [] }],
  ];

  it.each(cases)('400s %s', async (_name, route, body) => {
    const h = harness({ ledger: [row('reminder', '10')] });
    const res = await post(h, route, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toEqual(expect.any(String));
    expect(h.store.rows).toEqual([row('reminder', '10')]);
  });

  it('400s a body that is not JSON', async () => {
    const h = harness();
    expect((await call(h.app, 'POST', '/class-emails/e1/claim', '{nope')).status).toBe(400);
  });

  it('accepts exactly 500 results', async () => {
    const h = harness();
    const res = await post(h, 'result', sendResult('reminder', Array.from({ length: 500 }, (_, i) => ({ registrationId: `${i}`, status: 'sent' }))));
    expect(res.status).toBe(200);
  });
});

describe('sandbox lock', () => {
  const SANDBOX = 'sandbox-sink@svbc.org';
  const sandboxItems = () => [reg('10'), reg('11'), reg('12')];

  it('no real address appears in any response when sandboxRecipient is set, and a class of several still returns several', async () => {
    const h = harness({ sandbox: SANDBOX, items: sandboxItems(), ledger: [row('thank-you', '13')] });
    const gotten = await (await get(h)).text();
    const claimed = await (await post(h, 'claim', { kind: 'reminder' })).text();
    const again = await (await post(h, 'claim', { kind: 'reminder' })).text();
    const released = await (await post(h, 'release', { kind: 'reminder', sender: 'coach@svbc.org', registrationIds: ['10'] })).text();
    for (const text of [gotten, claimed, again, released]) expect(text).not.toContain('real.org');

    const kinds = JSON.parse(gotten).kinds;
    expect(kinds.reminder.recipients).toHaveLength(3);
    expect(kinds.reminder.recipients.every((r: any) => r.email === SANDBOX)).toBe(true);
    expect(kinds['thank-you'].unresolved.every((r: any) => r.email === SANDBOX)).toBe(true);
    const claimBody = JSON.parse(claimed);
    expect(claimBody.recipients.map((r: any) => r.registrationId)).toEqual(['10', '11', '12']);
    expect(claimBody.recipients.every((r: any) => r.email === SANDBOX)).toBe(true);
  });

  it('plans on the real addresses, so duplicates are still caught before the swap', async () => {
    const h = harness({ sandbox: SANDBOX, items: [reg('10', { [rc.attendeeEmailColumn]: 'same@real.org' }), reg('11', { [rc.attendeeEmailColumn]: 'Same@real.org' })] });
    const body = (await (await post(h, 'claim', { kind: 'reminder' })).json()) as any;
    expect(body.recipients.map((r: any) => r.registrationId)).toEqual(['10']);
  });

  it('uses the replaced address in the update Failed lines', async () => {
    const h = harness({ sandbox: SANDBOX, ledger: [row('reminder', '10'), row('reminder', '11')] });
    const res = await post(h, 'result', sendResult('reminder', [{ registrationId: '10', status: 'sent' }, { registrationId: '11', status: 'failed', error: 'bounced' }]));
    expect(await res.text()).not.toContain('real.org');
    const text = (h.client.postUpdate.mock.calls[0] as unknown as [string, string])[1];
    expect(text).toContain(`Failed: ${SANDBOX} (bounced)`);
    expect(text).not.toContain('real.org');
  });
});

describe('logging', () => {
  it('no address or name reaches console.*', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const h = harness({
      event: PAST,
      items: [reg('10', { [rc.attendanceColumn]: 'Attended' }), reg('11', { [rc.attendanceColumn]: 'Attended' })],
      peopleLookup: async () => { throw new Error('Monday refused p10@real.org for Al One'); },
      postUpdate: async () => { throw new Error('update for Bo Two at p11@real.org failed'); },
    });
    await get(h);
    const claim = (await (await post(h, 'claim', { kind: 'thank-you' })).json()) as any;
    expect(claim.recipients).toHaveLength(2);
    await post(h, 'result', sendResult('thank-you', [
      { registrationId: '10', status: 'sent' },
      { registrationId: '11', status: 'failed', error: 'rejected p11@real.org Bo Two' },
    ]));
    await post(h, 'release', { kind: 'thank-you', sender: 'coach@svbc.org', registrationIds: ['11'] });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secretBit of ['real.org', 'Al One', 'Bo Two', 'coach@svbc.org', 'See you soon', 'rejected']) expect(logged).not.toContain(secretBit);
    expect(spies.some((s) => s.mock.calls.length > 0)).toBe(true);
  });
});
