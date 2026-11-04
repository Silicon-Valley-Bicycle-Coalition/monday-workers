import { Hono } from 'hono';
import { secretsMatch } from './secret';
import type { RunRow } from './db/ledger';
import type { PassReport, SingleMoveResult } from './pass';
import { runDisposition, type WriteMode } from './flags';

export interface RoutesDeps {
  // Runs one pass now. dryRun comes from the write mode (off = dry) or a forced ?dryRun=true.
  runPass(opts: { dryRun: boolean; runId: string }): Promise<PassReport | { skipped: string }>;
  // Moves one person from People (Historical) to People, under the same write mode.
  moveToPeople(opts: { itemId: string; dryRun: boolean; runId: string }): Promise<SingleMoveResult>;
  recentRuns(): Promise<RunRow[]>;
  // The write switch, read once per request.
  mode(): Promise<WriteMode>;
  // The operator secret, presented as `Authorization: Bearer <secret>` (as report-digests does) —
  // never in the query string, where it would land in request logs (#64). Checked constant-time
  // and fail-closed: an unset/empty secret disables the routes entirely.
  secret?: string;
  now?: () => Date;
}

const MOVE_STATUS: Record<SingleMoveResult['outcome'], 200 | 404 | 409 | 502> = {
  moved: 200, 'dry-run': 200, 'already-on-people': 200,
  'not-found': 404, 'wrong-board': 409, refused: 409, skipped: 409,
  failed: 502, ambiguous: 502, error: 502,
};

// Whether a request writes: the write mode decides, and ?dryRun=true forces a preview.
function writeChoice(param: string | undefined, mode: WriteMode): { dryRun: boolean } | { status: 400 | 409 | 503; error: string } {
  if (param === 'false') return { status: 400, error: 'dryRun=false is no longer accepted; use scripts/flags.mjs' };
  if (param !== undefined && param !== 'true') return { status: 400, error: 'dryRun must be "true"' };
  if (param === 'true') {
    return mode === 'unknown' ? { status: 503, error: 'write mode is unknown (KV read failed)' } : { dryRun: true };
  }
  const disposition = runDisposition(mode);
  return disposition === 'skip' ? { status: 409, error: `write mode is ${mode}; nothing run` } : { dryRun: disposition === 'dry-run' };
}

// The operator surface: the cron calls the same pass, so there is no cron-only behaviour to
// reverse-engineer. POST /reclassify/run follows the write mode (scripts/flags.mjs); ?dryRun=true
// forces a plan-only pass in any mode but `unknown`. ?dryRun=false is gone: the switch is the only
// way to write.
export function createApp(deps: RoutesDeps) {
  const app = new Hono();
  const now = deps.now ?? (() => new Date());
  const authorized = (header: string | undefined) => secretsMatch(header?.match(/^Bearer (.+)$/)?.[1], deps.secret);

  app.get('/reclassify/status', async (c) => {
    if (!(await authorized(c.req.header('Authorization')))) return c.json({ ok: false }, 401);
    return c.json({ ok: true, mode: await deps.mode(), runs: await deps.recentRuns() });
  });

  app.post('/reclassify/run', async (c) => {
    if (!(await authorized(c.req.header('Authorization')))) return c.json({ ok: false }, 401);
    const choice = writeChoice(c.req.query('dryRun'), await deps.mode());
    if ('error' in choice) return c.json({ ok: false, error: choice.error }, choice.status);
    const runId = `http-${now().toISOString().replace(/[:.]/g, '-')}`;
    const result = await deps.runPass({ dryRun: choice.dryRun, runId });
    // Skipped: another pass holds the lease, or this run_id was already recorded.
    if ('skipped' in result) return c.json({ ok: false, ...result }, 409);
    return c.json({ ok: result.error === null, ...result });
  });

  // One person, now, rather than waiting for the next pass (src/pass.ts moveOneToPeople).
  app.post('/reclassify/move-to-people/:itemId', async (c) => {
    if (!(await authorized(c.req.header('Authorization')))) return c.json({ ok: false }, 401);
    const itemId = c.req.param('itemId');
    if (!/^\d+$/.test(itemId)) return c.json({ ok: false, error: 'item id must be numeric' }, 400);
    const choice = writeChoice(c.req.query('dryRun'), await deps.mode());
    if ('error' in choice) return c.json({ ok: false, error: choice.error }, choice.status);
    const runId = `move-${itemId}-${now().toISOString().replace(/[:.]/g, '-')}`;
    const result = await deps.moveToPeople({ itemId, dryRun: choice.dryRun, runId });
    const status = MOVE_STATUS[result.outcome];
    return c.json({ ok: status === 200, ...result }, status);
  });

  return app;
}
