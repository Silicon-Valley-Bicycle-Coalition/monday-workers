import { Hono } from 'hono';
import { secretsMatch } from './secret';
import type { RunRow } from './db/ledger';
import type { PassReport } from './pass';
import { runDisposition, type WriteMode } from './flags';

export interface RoutesDeps {
  // Runs one pass now. dryRun comes from the write mode (off = dry) or a forced ?dryRun=true.
  runPass(opts: { dryRun: boolean; runId: string }): Promise<PassReport | { skipped: string }>;
  recentRuns(): Promise<RunRow[]>;
  // The write switch, read once per request.
  mode(): Promise<WriteMode>;
  // The operator secret, presented as `Authorization: Bearer <secret>` (as report-digests does) —
  // never in the query string, where it would land in request logs (#64). Checked constant-time
  // and fail-closed: an unset/empty secret disables the routes entirely.
  secret?: string;
  now?: () => Date;
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
    const param = c.req.query('dryRun');
    if (param === 'false') return c.json({ ok: false, error: 'dryRun=false is no longer accepted; use scripts/flags.mjs' }, 400);
    if (param !== undefined && param !== 'true') return c.json({ ok: false, error: 'dryRun must be "true"' }, 400);
    const mode = await deps.mode();
    let dryRun: boolean;
    if (param === 'true') {
      if (mode === 'unknown') return c.json({ ok: false, error: 'write mode is unknown (KV read failed)' }, 503);
      dryRun = true;
    } else {
      const disposition = runDisposition(mode);
      if (disposition === 'skip') return c.json({ ok: false, error: `write mode is ${mode}; no pass run` }, 409);
      dryRun = disposition === 'dry-run';
    }
    const runId = `http-${now().toISOString().replace(/[:.]/g, '-')}`;
    const result = await deps.runPass({ dryRun, runId });
    // Skipped: another pass holds the lease, or this run_id was already recorded.
    if ('skipped' in result) return c.json({ ok: false, ...result }, 409);
    return c.json({ ok: result.error === null, ...result });
  });

  return app;
}
