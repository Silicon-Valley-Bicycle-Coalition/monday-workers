import { Hono } from 'hono';
import { secretsMatch } from './secret';
import type { RunRow } from './db/ledger';
import type { PassReport } from './pass';

export interface RoutesDeps {
  // Runs one pass now; dryRun comes from the request (?dryRun=false) or the environment's DRY_RUN.
  runPass(opts: { dryRun: boolean; runId: string }): Promise<PassReport | { skipped: string }>;
  recentRuns(): Promise<RunRow[]>;
  defaultDryRun: boolean;
  // Same shared-secret convention as the other Workers' operator routes (?secret=…), checked
  // constant-time and fail-closed: an unset/empty secret disables the routes entirely.
  secret?: string;
  now?: () => Date;
}

// The operator surface: the cron calls the same pass, so there is no cron-only behaviour to
// reverse-engineer. POST /reclassify/run is how the first live pass is driven in the sandbox
// (?dryRun=false) while the deployed DRY_RUN var still says true.
export function createApp(deps: RoutesDeps) {
  const app = new Hono();
  const now = deps.now ?? (() => new Date());
  const authorized = (secret: string | undefined) => secretsMatch(secret, deps.secret);

  app.get('/reclassify/status', async (c) => {
    if (!(await authorized(c.req.query('secret')))) return c.json({ ok: false }, 401);
    return c.json({ ok: true, dryRunDefault: deps.defaultDryRun, runs: await deps.recentRuns() });
  });

  app.post('/reclassify/run', async (c) => {
    if (!(await authorized(c.req.query('secret')))) return c.json({ ok: false }, 401);
    const param = c.req.query('dryRun');
    if (param !== undefined && param !== 'true' && param !== 'false') {
      return c.json({ ok: false, error: 'dryRun must be "true" or "false"' }, 400);
    }
    const dryRun = param === undefined ? deps.defaultDryRun : param === 'true';
    const runId = `http-${now().toISOString().replace(/[:.]/g, '-')}`;
    const result = await deps.runPass({ dryRun, runId });
    return c.json({ ok: !('skipped' in result) && result.error === null, ...result });
  });

  return app;
}
