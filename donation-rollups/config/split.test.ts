import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';
import type { VolunteerBoardConfig, HistoricalVolunteerBoardConfig } from '../src/types';
import { queueBaseName } from '../src/environment';
import { isDeadLetterBatch } from '../src/index';

// Keeps the sandbox and production deployments apart at the repo level: sandbox.json is the
// real, complete CRM Sandbox config; svbc.json is production and may hold no sandbox id; and
// env.sandbox in wrangler.jsonc shares no resource with the top level. See the design doc
// docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §5.

const PLACEHOLDER = 'REPLACE_WITH_COLUMN_ID';

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

function columnIds(columns: Record<string, unknown>): string[] {
  return Object.values(columns).flatMap((v) =>
    typeof v === 'string' ? [v] : v !== null && typeof v === 'object' ? columnIds(v as Record<string, unknown>) : []
  );
}

// Production ids are placeholders (0 or null) until the production boards exist at cutover;
// once they're real, they must differ from every sandbox id. Either state passes.
const isPlaceholder = (id: unknown) => id === 0 || id === '0' || id === null;

// Both configs ship `volunteerBoards` empty (Volunteers board only) (`[]` infers `never[]` from the JSON), so give them their real types.
const productionVolunteerBoards: VolunteerBoardConfig[] = production.donationRollups.volunteerBoards;
const sandboxVolunteerBoards: VolunteerBoardConfig[] = sandbox.donationRollups.volunteerBoards;
const sandboxHistoricalBoards: HistoricalVolunteerBoardConfig[] = sandbox.donationRollups.historicalVolunteerBoards;

describe('config split: board ids', () => {
  it('the sandbox Donations board is the CRM Sandbox one; production is a placeholder or a different board', () => {
    expect(sandbox.donationRollups.donationBoards[0]!.boardId).toBe(18437342657);
    const sandboxBoards = new Set(sandbox.donationRollups.donationBoards.map((b) => b.boardId));
    for (const { boardId } of production.donationRollups.donationBoards) {
      expect(isPlaceholder(boardId) || !sandboxBoards.has(boardId), String(boardId)).toBe(true);
    }
  });

  it('owner boards are the three CRM Sandbox boards in sandbox; production shares none of them', () => {
    const sandboxOwners = Object.keys(sandbox.donationRollups.ownerColumnsByBoard).sort();
    expect(sandboxOwners).toEqual(['18437342579', '18437342592', '18437342607']);
    for (const key of Object.keys(production.donationRollups.ownerColumnsByBoard)) {
      expect(isPlaceholder(key) || !sandboxOwners.includes(key), key).toBe(true);
    }
  });

  it('volunteer boards: production ids are placeholders or differ from the sandbox ones', () => {
    const sandboxBoards = new Set([
      ...sandboxVolunteerBoards.flatMap((b) => [b.boardId, b.eventBoard.boardId]),
      ...sandboxHistoricalBoards.map((b) => b.boardId),
    ]);
    for (const b of productionVolunteerBoards) {
      for (const id of [b.boardId, b.eventBoard.boardId]) expect(isPlaceholder(id) || !sandboxBoards.has(id), String(id)).toBe(true);
    }
    for (const b of production.donationRollups.historicalVolunteerBoards) {
      expect(isPlaceholder(b.boardId) || !sandboxBoards.has(b.boardId), String(b.boardId)).toBe(true);
    }
  });

  it('custodian ids are real in sandbox; production is a placeholder or a different id', () => {
    expect(sandbox.custodian.workspaceId).toBe(18210301);
    expect(sandbox.custodian.annualSummaryBoardId).toBe(18437530607);
    for (const key of ['workspaceId', 'annualSummaryBoardId'] as const) {
      const prod = production.custodian[key];
      expect(isPlaceholder(prod) || prod !== sandbox.custodian[key], key).toBe(true);
    }
  });

  // A null alertItemId silently drops the Monday alert (console.error only), and the sandbox once
  // posted to an unrelated production IT Requests ticket, so both ids are pinned, not just compared.
  it('custodian alerts each have their own item: never null, never shared', () => {
    expect(sandbox.custodian.alertItemId).toBe(13460723549);
    expect(production.custodian.alertItemId).toBe(13460707947);
  });
});

describe('config split: column ids', () => {
  it('no sandbox column id appears anywhere in production', () => {
    const sandboxIds = new Set([
      ...columnIds(sandbox.donationRollups.donationBoards[0]!.columns as Record<string, unknown>),
      ...Object.values(sandbox.donationRollups.ownerColumnsByBoard).flatMap((c) => columnIds(c as Record<string, unknown>)),
      ...columnIds((sandbox.custodian.annualSummaryColumns ?? {}) as Record<string, unknown>),
      ...sandboxVolunteerBoards.flatMap((b) => [...columnIds(b.columns as Record<string, unknown>), ...columnIds(b.eventBoard.columns as Record<string, unknown>)]),
      ...sandboxHistoricalBoards.flatMap((b) => columnIds(b.columns as Record<string, unknown>)),
    ]);
    expect(sandboxIds.size).toBeGreaterThan(40);
    expect(sandboxIds.has(PLACEHOLDER)).toBe(false);

    const productionText = JSON.stringify(production);
    for (const id of sandboxIds) {
      expect(productionText, id).not.toContain(`"${id}"`);
    }
  });

  it('both shipped configs validate', () => {
    expect(() => validateConfig(sandbox)).not.toThrow();
    expect(() => validateConfig(production)).not.toThrow();
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
  });

  it('routes the sandbox dead-letter queue to the dead-letter consumer and nothing else', () => {
    const consumers = (sandboxEnv.queues as Json).consumers as { queue: string; dead_letter_queue?: string }[];
    const recompute = consumers.find((c) => c.dead_letter_queue !== undefined)!;
    const dlq = consumers.find((c) => c.dead_letter_queue === undefined)!;
    expect(recompute.queue).toBe('donation-rollups-recompute-sandbox');
    expect(recompute.dead_letter_queue).toBe('donation-rollups-recompute-sandbox-dlq');
    expect(dlq.queue).toBe(recompute.dead_letter_queue);
    expect(isDeadLetterBatch(dlq.queue)).toBe(true);
    expect(isDeadLetterBatch(recompute.queue)).toBe(false);
  });

  it('mirrors the production consumer limits', () => {
    const prod = ((wrangler.queues as Json).consumers as Json[]).map((c) => [c.max_batch_size, c.max_retries, c.max_concurrency]);
    const sb = ((sandboxEnv.queues as Json).consumers as Json[]).map((c) => [c.max_batch_size, c.max_retries, c.max_concurrency]);
    expect(sb).toEqual(prod);
  });

  it('binds FLAGS to a different KV namespace than production', () => {
    const flagsId = (scope: Json) => (scope.kv_namespaces as { binding: string; id: string }[] | undefined)?.find((ns) => ns.binding === 'FLAGS')?.id;
    expect(flagsId(wrangler)).toBeTruthy();
    expect(flagsId(sandboxEnv)).toBeTruthy();
    expect(flagsId(sandboxEnv)).not.toBe(flagsId(wrangler));
  });

  it('gives the recompute consumer about four days of retries (max_retries 100) in both environments; the DLQ consumer is unchanged', () => {
    for (const queues of [wrangler.queues as Json, sandboxEnv.queues as Json]) {
      const consumers = queues.consumers as { max_retries: number; dead_letter_queue?: string }[];
      expect(consumers.find((c) => c.dead_letter_queue !== undefined)!.max_retries).toBe(100);
      expect(consumers.find((c) => c.dead_letter_queue === undefined)!.max_retries).toBe(2);
    }
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(sbDb.database_name).toBe('svbc-donation-rollups-sandbox');
    expect(sbDb.database_name).not.toBe(prodDb.database_name);
    expect(sbDb.database_id).not.toBe(prodDb.database_id);
  });

  it('keeps the same cron schedule as production and derives its own name', () => {
    expect((sandboxEnv.triggers as Json).crons).toEqual((wrangler.triggers as Json).crons);
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-donation-rollups');
  });
});

describe('membership: a Donor Advised Fund gift renews like a Donation', () => {
  it.each([['production', production], ['sandbox', sandbox]])('%s lists both as eligible', (_name, config) => {
    expect(validateConfig(config).donationRollups.membership?.eligibleGiftTypes).toEqual(['Donation', 'Donor Advised Fund']);
  });
});
