// The routes the class email send page (a Google Apps Script web app) calls. They hand real
// student addresses to that page and decide who may be emailed, so: every route checks the shared
// secret before anything else (including before the Monday client is built), the ledger is written
// before any Monday write, and nothing personal reaches console.* (ids, counts and error class
// names only; an `error` string from the page may hold an address, so it is never logged).
import type { Context, Hono } from 'hono';
import type { AttendeeStore } from '../db/attendees';
import type { ClassEmailKind, ClassEmailRow, ClassEmailStore } from '../db/classEmails';
import type { EventStore } from '../db/events';
import type { WriteMode } from '../flags';
import { matchPerson } from '../matching/people';
import { isActive, statusText, type MondayClient } from '../monday/client';
import type { EventbriteSyncConfig, EventRow } from '../types';
import { linkedItemId } from '../util/itemId';
import { secretsMatch } from '../webhook/route';
import { planKind, type ClassFacts, type KindPlan, type Recipient, type RosterEntry } from './plan';
import { loadRoster, sandboxRecipients } from './roster';

export const CLASS_EMAIL_SECRET_HEADER = 'X-Class-Email-Secret';

export interface ClassEmailRouteDeps {
  store: ClassEmailStore;
  // A function so a missing Monday binding can't break the webhook routes, and so it is only
  // called once the secret has passed.
  mondayClient: () => MondayClient;
  secret: string | undefined;
  eventStore: EventStore;
  attendeeStore: AttendeeStore;
  config: EventbriteSyncConfig;
  writeMode: () => Promise<WriteMode>;
  now?: () => Date;
}

const KINDS: ClassEmailKind[] = ['reminder', 'thank-you', 'missed-you'];
const KIND_LABEL: Record<ClassEmailKind, string> = { reminder: 'Reminder', 'thank-you': 'Thank-you', 'missed-you': 'Missed-you' };
const MAX_ENTRIES = 500;
const MAX_TEXT = 200;
// Deliberately loose: it only has to stop obvious junk, Gmail is the real judge of an address.
const ADDRESS_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

class BadRequest extends Error {}

// The route pattern guarantees the segment; the type doesn't know that.
const idOf = (c: Context): string => c.req.param('eventId') ?? '';

const isKind = (value: unknown): value is ClassEmailKind => typeof value === 'string' && (KINDS as string[]).includes(value);

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequest('The body must be a JSON object.');
  return body as Record<string, unknown>;
}

function kindOf(body: Record<string, unknown>): ClassEmailKind {
  if (!isKind(body.kind)) throw new BadRequest('"kind" must be reminder, thank-you or missed-you.');
  return body.kind;
}

function senderOf(body: Record<string, unknown>): string {
  const { sender } = body;
  if (typeof sender !== 'string' || sender.length > 254 || !ADDRESS_PATTERN.test(sender)) throw new BadRequest('"sender" must be an email address.');
  return sender;
}

interface SendResult {
  registrationId: string;
  status: 'sent' | 'failed';
  error: string;
}

function parseResult(raw: unknown): { kind: ClassEmailKind; sender: string; subject: string; results: SendResult[] } {
  const body = bodyObject(raw);
  const kind = kindOf(body);
  const sender = senderOf(body);
  if (typeof body.subject !== 'string') throw new BadRequest('"subject" must be a string.');
  if (!Array.isArray(body.results)) throw new BadRequest('"results" must be an array.');
  if (body.results.length > MAX_ENTRIES) throw new BadRequest(`"results" can hold at most ${MAX_ENTRIES} entries.`);
  const results = body.results.map((entry: unknown): SendResult => {
    if (typeof entry !== 'object' || entry === null) throw new BadRequest('Each result must be an object.');
    const { registrationId, status, error } = entry as Record<string, unknown>;
    if (typeof registrationId !== 'string' || registrationId === '') throw new BadRequest('Each result needs a "registrationId" string.');
    if (status !== 'sent' && status !== 'failed') throw new BadRequest('Each result "status" must be sent or failed.');
    if (error !== undefined && typeof error !== 'string') throw new BadRequest('A result "error" must be a string.');
    return { registrationId, status, error: error ?? '' };
  });
  return { kind, sender, subject: body.subject, results };
}

function parseRelease(raw: unknown): { kind: ClassEmailKind; sender: string; registrationIds: string[] } {
  const body = bodyObject(raw);
  const kind = kindOf(body);
  const sender = senderOf(body);
  const ids = body.registrationIds;
  if (!Array.isArray(ids)) throw new BadRequest('"registrationIds" must be an array.');
  if (ids.length > MAX_ENTRIES) throw new BadRequest(`"registrationIds" can hold at most ${MAX_ENTRIES} entries.`);
  if (!ids.every((id): id is string => typeof id === 'string' && id !== '')) throw new BadRequest('"registrationIds" must be strings.');
  return { kind, sender, registrationIds: ids };
}

// Free text from the page, for a Monday update: one line, bounded.
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

// Monday errors can echo what was sent, so only the class of the failure is ever logged.
const errorKind = (err: unknown): string => (err instanceof Error ? err.name : 'unknown error');

export function registerClassEmailRoutes(app: Hono, deps: ClassEmailRouteDeps): void {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const boards = config.monday.boards;
  const rc = config.attendeeSync.registrations;

  const json = (c: Context, body: unknown, status: 200 | 400 | 401 | 404 | 502 | 503 = 200) => {
    // Responses carry names and addresses: nothing may keep a copy.
    c.header('Cache-Control', 'no-store');
    return c.json(body as object, status);
  };
  const fail = (c: Context, status: 400 | 401 | 404 | 502 | 503, error: string) => json(c, { error }, status);

  const authorized = (c: Context) => secretsMatch(c.req.header(CLASS_EMAIL_SECRET_HEADER), deps.secret);

  async function readJson(c: Context): Promise<unknown> {
    try {
      return await c.req.json();
    } catch {
      throw new BadRequest('The body must be JSON.');
    }
  }

  const writesRefusal = (c: Context) => fail(c, 503, 'Class email writes are not switched on, so nothing can be sent right now.');

  // The class: its ledger row, with a Monday item. Null is a 404.
  async function findEvent(eventId: string): Promise<(EventRow & { mondayItemId: string }) | null> {
    const event = await deps.eventStore.getEvent(eventId);
    return event !== null && event.mondayItemId !== null ? { ...event, mondayItemId: event.mondayItemId } : null;
  }

  const factsOf = (event: EventRow): ClassFacts => ({ startsAt: event.startsAt, endsAt: event.endsAt, eventbriteStatus: event.eventbriteStatus });

  const notFound = (c: Context) => fail(c, 404, 'No such class.');
  const unconfigured = (c: Context) => fail(c, 503, 'Class emails are not set up for this environment.');
  const configured = () => boards.events !== null && boards['event-registrations'] !== null;

  // Wraps a route body: validation errors are 400s, anything else is logged by class and answered
  // 502 (the Worker's own bug or Monday/D1 being down), never with the error text.
  function handle(route: string, run: (c: Context) => Promise<Response>) {
    return async (c: Context): Promise<Response> => {
      if (!(await authorized(c))) return fail(c, 401, 'Unauthorized.');
      try {
        return await run(c);
      } catch (err) {
        if (err instanceof BadRequest) return fail(c, 400, err.message);
        console.error(`eventbrite-sync class emails: ${route} failed for event "${idOf(c)}": ${errorKind(err)}`);
        return fail(c, 502, 'The class email service could not finish that request.');
      }
    };
  }

  // Plans one kind against live roster and ledger, then swaps in the sandbox address (never before:
  // the one-address rule needs the real ones).
  function planAll(kinds: ClassEmailKind[], event: EventRow, roster: RosterEntry[], ledger: ClassEmailRow[], at: Date): Record<string, KindPlan> {
    const out: Record<string, KindPlan> = {};
    for (const kind of kinds) {
      const plan = planKind(kind, factsOf(event), roster, ledger, at);
      out[kind] = { ...plan, recipients: sandboxRecipients(plan.recipients, config), unresolved: sandboxRecipients(plan.unresolved, config) };
    }
    return out;
  }

  app.get('/class-emails/:eventId', handle('GET', async (c) => {
    if (!configured()) return unconfigured(c);
    const eventId = idOf(c);
    const event = await findEvent(eventId);
    if (event === null) return notFound(c);

    const client = deps.mondayClient();
    const [[item], roster, ledger, mode] = await Promise.all([
      client.getItems(boards.events!, [event.mondayItemId], []),
      loadRoster(eventId, { attendeeStore: deps.attendeeStore, mondayClient: client, config }),
      store.listByEvent(eventId),
      deps.writeMode(),
    ]);
    if (!isActive(item)) return notFound(c);

    return json(c, {
      event: { name: item.name, startsAt: event.startsAt, endsAt: event.endsAt, status: event.eventbriteStatus },
      writesOn: mode === 'on',
      kinds: planAll(KINDS, event, roster, ledger, now()),
    });
  }));

  app.post('/class-emails/:eventId/claim', handle('claim', async (c) => {
    const kind = kindOf(bodyObject(await readJson(c)));
    if ((await deps.writeMode()) !== 'on') return writesRefusal(c);
    if (!configured()) return unconfigured(c);
    const eventId = idOf(c);
    const event = await findEvent(eventId);
    if (event === null) return notFound(c);

    // Always re-planned from live data: what the page was shown earlier may be stale.
    const client = deps.mondayClient();
    const at = now();
    const [roster, ledger] = await Promise.all([loadRoster(eventId, { attendeeStore: deps.attendeeStore, mondayClient: client, config }), store.listByEvent(eventId)]);
    const plan = planKind(kind, factsOf(event), roster, ledger, at);
    if (plan.refusal !== null) return json(c, { refusal: plan.refusal, recipients: [] });

    // Only what this call newly claimed goes back; a concurrent claim keeps its own.
    const claimed = new Set(await store.claim(eventId, kind, plan.recipients.map((r) => r.registrationId), at.toISOString()));
    const granted: Recipient[] = plan.recipients.filter((r) => claimed.has(r.registrationId));
    console.log(`eventbrite-sync class emails: claimed ${granted.length} of ${plan.recipients.length} ${kind} for event "${eventId}"`);
    return json(c, { refusal: null, recipients: sandboxRecipients(granted, config) });
  }));

  app.post('/class-emails/:eventId/result', handle('result', async (c) => {
    const { kind, sender, subject, results } = parseResult(await readJson(c));
    if ((await deps.writeMode()) !== 'on') return writesRefusal(c);
    if (!configured()) return unconfigured(c);
    const eventId = idOf(c);
    const event = await findEvent(eventId);
    if (event === null) return notFound(c);

    // Only a registration this event and kind has claimed, and not yet resolved, can be recorded.
    const ledger = await store.listByEvent(eventId);
    const claimedIds = new Set(ledger.filter((r) => r.kind === kind && r.status === 'claimed').map((r) => r.registrationId));
    const acted = new Map<string, SendResult>();
    for (const r of results) if (claimedIds.has(r.registrationId) && !acted.has(r.registrationId)) acted.set(r.registrationId, r);

    // Ledger first: whatever Monday does next cannot lose what was sent.
    const resolvedAt = now().toISOString();
    for (const r of acted.values()) await store.resolve(eventId, kind, r.registrationId, r.status, resolvedAt);

    const sentIds = [...acted.values()].filter((r) => r.status === 'sent').map((r) => r.registrationId);
    const failed = [...acted.values()].filter((r) => r.status === 'failed');
    const unresolved = ledger.filter((r) => r.kind === kind && (acted.get(r.registrationId)?.status ?? r.status) !== 'sent').length;
    console.log(`eventbrite-sync class emails: result for event "${eventId}" ${kind}: ${sentIds.length} sent, ${failed.length} failed, ${results.length - acted.size} ignored`);

    if (acted.size > 0) {
      let client: MondayClient | null = null;
      try {
        client = deps.mondayClient();
      } catch (err) {
        console.error(`eventbrite-sync class emails: no Monday client after result for event "${eventId}": ${errorKind(err)}`);
      }
      if (client !== null) {
        await followUp(client, kind, sentIds, eventId);
        await postResultUpdate(client, event.mondayItemId, eventId, kind, sender, subject, sentIds.length, failed);
      }
    }
    return json(c, { ok: true, sent: sentIds.length, failed: failed.length, unresolved });
  }));

  app.post('/class-emails/:eventId/release', handle('release', async (c) => {
    const { kind, sender, registrationIds } = parseRelease(await readJson(c));
    if ((await deps.writeMode()) !== 'on') return writesRefusal(c);
    if (!configured()) return unconfigured(c);
    const eventId = idOf(c);
    const event = await findEvent(eventId);
    if (event === null) return notFound(c);

    // A `sent` row is never released; ids with no row are ignored.
    const wanted = new Set(registrationIds);
    const releasable = (await store.listByEvent(eventId)).filter((r) => r.kind === kind && r.status !== 'sent' && wanted.has(r.registrationId)).map((r) => r.registrationId);
    await store.release(eventId, kind, releasable);
    console.log(`eventbrite-sync class emails: released ${releasable.length} ${kind} for event "${eventId}"`);

    if (releasable.length > 0) {
      const people = releasable.length === 1 ? 'person' : 'people';
      await postUpdate(event.mondayItemId, eventId, `Class email: ${KIND_LABEL[kind]}. ${sender} released ${releasable.length} ${people} who ${releasable.length === 1 ? 'was' : 'were'} not confirmed sent, so they can be emailed again.`);
    }
    return json(c, { ok: true });
  }));

  async function postUpdate(itemId: string, eventId: string, body: string, client?: MondayClient): Promise<void> {
    try {
      await (client ?? deps.mondayClient()).postUpdate(itemId, body);
    } catch (err) {
      console.error(`eventbrite-sync class emails: update on event "${eventId}" not posted: ${errorKind(err)}`);
    }
  }

  // What the ledger doesn't cover: a missed-you marks No Show and a thank-you links People. Each
  // item is independent and none of it can undo the ledger, so a failure is logged and skipped.
  async function followUp(client: MondayClient, kind: ClassEmailKind, sentIds: string[], eventId: string): Promise<void> {
    if (sentIds.length === 0 || kind === 'reminder') return;
    const regBoard = boards['event-registrations']!;
    try {
      if (kind === 'missed-you') {
        // Fresh: staff may have checked someone in since the page was loaded.
        const fresh = (await client.getItems(regBoard, sentIds, [rc.attendanceColumn])).filter(isActive);
        for (const item of fresh) {
          if (statusText(item, rc.attendanceColumn) !== 'Registered') continue;
          await writeRegistration(client, regBoard, item.id, { [rc.attendanceColumn]: 'No Show' }, eventId);
        }
        return;
      }
      const peopleBoard = boards['people-live'];
      if (peopleBoard === null) return;
      const fresh = (await client.getItems(regBoard, sentIds, [rc.attendeeEmailColumn, rc.attendeeLinkColumn])).filter(isActive);
      for (const item of fresh) {
        if ((item.columns[rc.attendeeLinkColumn] ?? '').trim() !== '') continue; // never overwrite a link
        try {
          const match = await matchPerson(client, peopleBoard, config.attendeeSync.peopleEmailColumn, { email: item.columns[rc.attendeeEmailColumn], name: item.name });
          if (match.donorItemId === null) continue;
          await writeRegistration(client, regBoard, item.id, { [rc.attendeeLinkColumn]: { item_ids: [linkedItemId(match.donorItemId)] } }, eventId);
        } catch (err) {
          console.error(`eventbrite-sync class emails: People link for registration ${item.id} on event "${eventId}" failed: ${errorKind(err)}`);
        }
      }
    } catch (err) {
      console.error(`eventbrite-sync class emails: ${kind} follow-up for event "${eventId}" failed: ${errorKind(err)}`);
    }
  }

  async function writeRegistration(client: MondayClient, board: number, itemId: string, values: Record<string, unknown>, eventId: string): Promise<void> {
    try {
      await client.changeColumnValues(board, itemId, values);
    } catch (err) {
      console.error(`eventbrite-sync class emails: write to registration ${itemId} on event "${eventId}" failed: ${errorKind(err)}`);
    }
  }

  async function postResultUpdate(
    client: MondayClient, itemId: string, eventId: string, kind: ClassEmailKind, sender: string, subject: string, sent: number, failed: SendResult[]
  ): Promise<void> {
    const lines = [`Class email: ${KIND_LABEL[kind]}, "${oneLine(subject)}". Sent by ${sender} to ${sent} ${sent === 1 ? 'person' : 'people'}.`];
    if (failed.length > 0) {
      // Addresses come from Monday now, not from the page; in the sandbox they are the replaced one.
      let addresses = new Map<string, string>();
      try {
        const roster = await loadRoster(eventId, { attendeeStore: deps.attendeeStore, mondayClient: client, config });
        const shown = sandboxRecipients(roster.map((e) => ({ registrationId: e.registrationId, email: e.email, firstName: e.firstName, name: e.name })), config);
        addresses = new Map(shown.map((r) => [r.registrationId, r.email]));
      } catch (err) {
        console.error(`eventbrite-sync class emails: could not look up failed addresses for event "${eventId}": ${errorKind(err)}`);
      }
      for (const f of failed) {
        lines.push(`Failed: ${addresses.get(f.registrationId) || `registration ${f.registrationId}`} (${oneLine(f.error) || 'no reason given'})`);
      }
    }
    await postUpdate(itemId, eventId, lines.join('\n'), client);
  }
}
