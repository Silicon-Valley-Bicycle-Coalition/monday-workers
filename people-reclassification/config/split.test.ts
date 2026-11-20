import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import { validateConfig } from '../src/config';

// Keeps the sandbox and production deployments apart at the repo level: sandbox.json is the
// real, complete CRM Sandbox config; svbc.json is production and may hold no sandbox id; and
// env.sandbox in wrangler.jsonc shares no resource with the top level. See the design doc
// docs/superpowers/specs/2026-09-18-sandbox-environment-design.md §5. This Worker names columns
// by title, not id, so the id checks here are board ids only.

type Json = Record<string, unknown>;
const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, key) => (o as Json | undefined)?.[key], obj);

const wrangler = parseJsonc(wranglerText) as Json;
const sandboxEnv = get(wrangler, 'env.sandbox') as Json;

// Production ids are placeholders (0) until the production boards exist at cutover; once
// they're real, they must differ from every sandbox id. Either state passes.
const isPlaceholder = (id: unknown) => id === 0;

interface BoardIdSources {
  boards: { live: { boardId: number }; historical: { boardId: number } };
  eventRegistrations: { boardId: number; events: { boardId: number } } | null;
  volunteers: { boardId: number } | null;
  loggedActivities: { boardId: number } | null;
}
const boardIds = (cfg: BoardIdSources): number[] => [
  cfg.boards.live.boardId, cfg.boards.historical.boardId,
  ...(cfg.eventRegistrations ? [cfg.eventRegistrations.boardId, cfg.eventRegistrations.events.boardId] : []),
  ...(cfg.volunteers ? [cfg.volunteers.boardId] : []),
  ...(cfg.loggedActivities ? [cfg.loggedActivities.boardId] : []),
];

describe('config split: board ids', () => {
  it('the sandbox boards are the CRM Sandbox v4 ones', () => {
    expect(sandbox.boards.live.boardId).toBe(18437342592);
    expect(sandbox.boards.historical.boardId).toBe(18437342607);
    expect(boardIds(sandbox).every((id) => id > 0)).toBe(true);
  });

  it('production shares no board with the sandbox, or is still a placeholder', () => {
    const sandboxIds = new Set(boardIds(sandbox));
    for (const id of boardIds(production)) expect(isPlaceholder(id) || !sandboxIds.has(id), String(id)).toBe(true);
  });

  it('the sandbox never raises items on the production IT Requests board', () => {
    expect(sandbox.alerts.itRequests).toBeNull();
    expect(production.alerts.itRequests?.boardId).toBe(8846215481);
  });

  it('both shipped configs validate', () => {
    expect(() => validateConfig(sandbox)).not.toThrow();
    expect(() => validateConfig(production)).not.toThrow();
  });

  it('both use the 100,000-item board limit Monday reports for SVBC (decided 2026-11-03)', () => {
    // 10,000 made the Historical warning, its IT Requests alert and the move headroom fire at a
    // tenth of the real ceiling (production Historical was already at "80%" with 8,037 items).
    expect(production.thresholds.itemsLimit).toBe(100_000);
    expect(sandbox.thresholds.itemsLimit).toBe(100_000);
  });
});

describe('wrangler.jsonc env.sandbox', () => {
  it('sets ENVIRONMENT only under env.sandbox, requires the webhook JWT in both, and carries no DRY_RUN', () => {
    expect(sandboxEnv.vars).toEqual({ ENVIRONMENT: 'sandbox', MONDAY_WEBHOOK_JWT_REQUIRED: 'true' });
    expect(wrangler.vars).toEqual({ MONDAY_WEBHOOK_JWT_REQUIRED: 'true' });
    expect(wranglerText).not.toContain('DRY_RUN');
  });

  it('has its own FLAGS KV namespace, never production’s', () => {
    const prodKv = (wrangler.kv_namespaces as Json[]).find((k) => k.binding === 'FLAGS')!;
    const sbKv = (sandboxEnv.kv_namespaces as Json[]).find((k) => k.binding === 'FLAGS')!;
    expect(sbKv.id).not.toBe(prodKv.id);
  });

  it('has its own D1 database, never production’s', () => {
    const prodDb = (wrangler.d1_databases as Json[])[0]!;
    const sbDb = (sandboxEnv.d1_databases as Json[])[0]!;
    expect(sbDb.database_name).toBe('svbc-people-reclassification-sandbox');
    expect(sbDb.database_name).not.toBe(prodDb.database_name);
    expect(sbDb.database_id).not.toBe(prodDb.database_id);
  });

  it('has its own rate-limit namespace and the same cron, CPU cap and Issues setting as production', () => {
    const prodLimiter = (wrangler.ratelimits as Json[])[0]!;
    const sbLimiter = (sandboxEnv.ratelimits as Json[])[0]!;
    expect(sbLimiter.namespace_id).not.toBe(prodLimiter.namespace_id);
    expect((sandboxEnv.triggers as Json).crons).toEqual([]); // sandbox crons are disabled to save cost
    expect(sandboxEnv.limits).toEqual(wrangler.limits);
    expect(get(sandboxEnv, 'observability.issues.enabled')).toBe(true);
    expect(get(wrangler, 'observability.issues.enabled')).toBe(true);
  });

  it('derives its own name', () => {
    expect(sandboxEnv.name).toBeUndefined();
    expect(wrangler.name).toBe('svbc-people-reclassification');
  });
});
