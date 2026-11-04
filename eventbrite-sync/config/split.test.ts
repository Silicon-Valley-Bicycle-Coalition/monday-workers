import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig, PLACEHOLDER_COLUMN_ID } from '../src/config';
import { queueBaseName } from '../src/environment';
import { isDeadLetterBatch } from '../src/index';

// Keeps the sandbox and production deployments apart at the repo level: sandbox.json is the
// real CRM Sandbox config; svbc.json is production and may hold no sandbox id; and env.sandbox
// in wrangler.jsonc shares no resource with the top level. See the design doc
// docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §5.

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

const BOARD_KEYS = ['donations:live', 'people-live', 'events', 'event-registrations'];
const COLUMN_KEYS = [
  'eventbriteSync.amountColumn',
  'eventbriteSync.statusColumn',
  'eventbriteSync.dateColumn',
  'eventbriteSync.thankYouSentColumn',
  'eventbriteSync.giftTypeColumn',
  'eventbriteSync.fiscalYearColumn',
  'eventbriteSync.donorEmailColumn',
  'eventbriteSync.donorLinkColumn',
  'attendeeSync.events.eventbriteIdColumn',
  'attendeeSync.events.dateColumn',
  'attendeeSync.events.endColumn',
  'attendeeSync.events.venueColumn',
  'attendeeSync.events.addressColumn',
  'attendeeSync.events.cityColumn',
  'attendeeSync.events.programColumn',
  'attendeeSync.events.eventStatusColumn',
  'attendeeSync.events.sourceColumn',
  'attendeeSync.events.urlColumn',
  'attendeeSync.events.classTypeColumn',
  'attendeeSync.events.followupsColumn',
  'attendeeSync.registrations.attendeeIdColumn',
  'attendeeSync.registrations.attendeeNameColumn',
  'attendeeSync.registrations.attendeeEmailColumn',
  'attendeeSync.registrations.firstNameColumn',
  'attendeeSync.registrations.attendanceColumn',
  'attendeeSync.registrations.sourceColumn',
  'attendeeSync.registrations.roleColumn',
  'attendeeSync.registrations.eventLinkColumn',
  'attendeeSync.registrations.attendeeLinkColumn',
  'attendeeSync.registrations.classDateColumn',
  'attendeeSync.registrations.classDayColumn',
  'attendeeSync.registrations.classLocationColumn',
  'attendeeSync.registrations.classTypeColumn',
  'attendeeSync.registrations.followupEmailColumn',
  'attendeeSync.peopleEmailColumn',
];

describe('config split: board and column ids', () => {
  it.each(BOARD_KEYS)('monday.boards.%s is a real sandbox id and null in production', (key) => {
    const sb = (sandbox.monday.boards as Record<string, unknown>)[key];
    const prod = (production.monday.boards as Record<string, unknown>)[key];
    expect(typeof sb).toBe('number');
    expect(sb).toBeGreaterThan(0);
    expect(prod === null || prod !== sb).toBe(true);
  });

  it.each(COLUMN_KEYS)('%s: a real sandbox id never appears in production', (path) => {
    const sb = get(sandbox, path);
    const prod = get(production, path);
    if (sb === null) return;
    expect(sb).not.toBe(PLACEHOLDER_COLUMN_ID);
    expect(prod === PLACEHOLDER_COLUMN_ID || prod === null || prod !== sb).toBe(true);
  });

  // The idempotency key. salesforce-import creates the column on production Donations at the load
  // (#44, README "Prerequisite column"), so the cutover fills production's id while the sandbox
  // config may still hold the placeholder: either side may be the placeholder, but a real sandbox
  // id must never reach production.
  it('orderIdColumn: a real sandbox id never appears in production', () => {
    const sb = sandbox.eventbriteSync.orderIdColumn;
    const prod = production.eventbriteSync.orderIdColumn;
    expect(sb === PLACEHOLDER_COLUMN_ID || prod !== sb).toBe(true);
  });

  // The order path is live in production (2026-11-02): every Donations/People key is filled from
  // the production boards.
  it('production fills the order path: both boards and every eventbriteSync column', () => {
    expect(production.monday.boards['donations:live']).toBe(18437909794);
    expect(production.monday.boards['people-live']).toBe(18437909781);
    for (const [key, value] of Object.entries(production.eventbriteSync)) {
      if (key.endsWith('Column')) expect(value, key).toMatch(/^[a-z_]+_mm[0-9a-z]+$/);
    }
  });

  it('both shipped configs validate', () => {
    expect(() => validateConfig(sandbox)).not.toThrow();
    expect(() => validateConfig(production)).not.toThrow();
  });

  // SVBC sends class emails by hand (2026-10-28), so production has no Class Type column for staff
  // to set, and the follow-up job, which skips an event with no Class Type, can never label anyone.
  // Filling these three means deciding to turn follow-ups on.
  it('production fills the attendee feed but leaves the follow-up columns as placeholders', () => {
    const followupOnly = ['attendeeSync.events.classTypeColumn', 'attendeeSync.events.followupsColumn',
      'attendeeSync.registrations.classTypeColumn', 'attendeeSync.registrations.followupEmailColumn'];
    expect(production.monday.boards['events']).toBe(18437909790);
    expect(production.monday.boards['event-registrations']).toBe(18437909792);
    for (const path of COLUMN_KEYS.filter((k) => k.startsWith('attendeeSync.'))) {
      if (followupOnly.includes(path)) expect(get(production, path), path).toBe(PLACEHOLDER_COLUMN_ID);
      else expect(get(production, path), path).toMatch(/^[a-z_]+_mm[0-9a-z]+$/);
    }
  });

  it('sandbox.json targets the CRM Sandbox (sandbox v3) Donations and People boards — the same ones funraise-sync writes', () => {
    expect(sandbox.monday.boards['donations:live']).toBe(18431577310);
    expect(sandbox.monday.boards['people-live']).toBe(18431577220);
  });

  it('sandbox.json targets the Events and Event Registrations (sandbox v3) boards; production never shares them', () => {
    expect(sandbox.monday.boards['events']).toBe(18431577282);
    expect(sandbox.monday.boards['event-registrations']).toBe(18431577302);
    expect(production.monday.boards['events']).not.toBe(18431577282);
    expect(production.monday.boards['event-registrations']).not.toBe(18431577302);
  });

  it('attendee follow-ups: sandbox notifies David; production is unset until the cutover fills it', () => {
    expect(sandbox.attendeeSync.followups).toEqual({ maxAgeDays: 3, sendHourLocal: 8, notifyUserId: 74336833 });
    const prodUser: unknown = production.attendeeSync.followups.notifyUserId;
    expect(prodUser === null || (typeof prodUser === 'number' && prodUser > 0)).toBe(true);
    expect(sandbox.attendeeSync.peopleEmailColumn).toBe('email_mm79m5qa');
  });

  it('both configs subscribe the three order actions and map placed/refunded to the labels funraise-sync writes', () => {
    for (const cfg of [sandbox, production]) {
      expect(cfg.eventbrite.actions).toEqual(['order.placed', 'order.updated', 'order.refunded']);
      expect(cfg.eventbriteSync.statusLabelMap).toEqual({ placed: 'Received', refunded: 'Refunded' });
      expect(cfg.eventbriteSync.giftTypeValue).toBe('Event Ticket');
      expect(cfg.eventbrite.apiUrl).toBe('https://www.eventbriteapi.com/v3');
    }
  });

  it('no sandbox column id string-appears anywhere in production', () => {
    const ids = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && /^[a-z_]+_mm[0-9a-z]+$/.test(value)) ids.add(value);
      else if (value !== null && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(collect);
    };
    collect(sandbox.eventbriteSync);
    collect(sandbox.attendeeSync);
    expect(ids.size).toBeGreaterThan(30);
    const productionText = JSON.stringify(production);
    for (const id of ids) {
      expect(productionText, id).not.toContain(`"${id}"`);
    }
  });
});

describe('wrangler.jsonc env.sandbox', () => {
  it('sets only the ENVIRONMENT var, and never at the top level', () => {
    expect(sandboxEnv.vars).toEqual({ ENVIRONMENT: 'sandbox' });
    expect((wrangler.vars as Json | undefined)?.ENVIRONMENT).toBeUndefined();
  });

  it('uses sandbox-suffixed queue names that map back to the production queues', () => {
    const prodProducers = ((wrangler.queues as Json).producers as { queue: string }[]).map((p) => p.queue);
    const sbQueues = sandboxEnv.queues as Json;
    for (const producer of sbQueues.producers as { queue: string }[]) {
      expect(producer.queue.endsWith('-sandbox')).toBe(true);
      expect(prodProducers).toContain(queueBaseName(producer.queue));
    }
    const consumers = sbQueues.consumers as { queue: string; dead_letter_queue?: string }[];
    const writers = consumers.filter((c) => c.dead_letter_queue !== undefined);
    expect(writers.length).toBeGreaterThan(0);
    for (const consumer of writers) {
      expect(consumer.queue.endsWith('-sandbox')).toBe(true);
      expect(consumer.dead_letter_queue).toBe(`${consumer.queue}-dlq`);
    }
  });

  it('routes each dead-letter queue to the dead-letter consumer, in both environments', () => {
    for (const queues of [wrangler.queues as Json, sandboxEnv.queues as Json]) {
      const consumers = queues.consumers as { queue: string; dead_letter_queue?: string }[];
      const writer = consumers.find((c) => c.dead_letter_queue !== undefined)!;
      const dlq = consumers.find((c) => c.dead_letter_queue === undefined)!;
      expect(dlq.queue).toBe(writer.dead_letter_queue);
      expect(isDeadLetterBatch(dlq.queue)).toBe(true);
      expect(isDeadLetterBatch(writer.queue)).toBe(false);
    }
  });

  it('binds FLAGS to a different KV namespace than production', () => {
    const flagsId = (scope: Json) => (scope.kv_namespaces as { binding: string; id: string }[] | undefined)?.find((ns) => ns.binding === 'FLAGS')?.id;
    expect(flagsId(wrangler)).toBeTruthy();
    expect(flagsId(sandboxEnv)).toBeTruthy();
    expect(flagsId(sandboxEnv)).not.toBe(flagsId(wrangler));
  });

  it('gives the write consumer about four days of retries (max_retries 100) in both environments; the DLQ consumer is unchanged', () => {
    for (const queues of [wrangler.queues as Json, sandboxEnv.queues as Json]) {
      const consumers = queues.consumers as { max_retries: number; dead_letter_queue?: string }[];
      expect(consumers.find((c) => c.dead_letter_queue !== undefined)!.max_retries).toBe(100);
      expect(consumers.find((c) => c.dead_letter_queue === undefined)!.max_retries).toBe(2);
    }
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(sbDb.database_name).toBe('svbc-eventbrite-sync-sandbox');
    expect(sbDb.database_name).not.toBe(prodDb.database_name);
    expect(sbDb.database_id).not.toBe(prodDb.database_id);
  });

  it('has its own rate-limit namespace', () => {
    const prod = (wrangler.ratelimits as Json[])[0]!;
    const sb = (sandboxEnv.ratelimits as Json[])[0]!;
    expect(sb.namespace_id).not.toBe(prod.namespace_id);
  });

  it('runs the follow-up sweep hourly in both environments (wrangler does not inherit triggers)', () => {
    expect((wrangler.triggers as Json | undefined)?.crons).toEqual(['0 * * * *']);
    expect((sandboxEnv.triggers as Json | undefined)?.crons).toEqual(['0 * * * *']);
  });

  it('does not set a name — Wrangler derives svbc-eventbrite-sync-sandbox', () => {
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-eventbrite-sync');
  });
});
