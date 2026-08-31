import { Hono } from 'hono';
import { DUTIES, type Duty, type DutyReport } from './custodian';

export interface CustodianAppDeps {
  runDuty(duty: Duty): Promise<DutyReport>;
  lastRuns(): Promise<unknown>;
  // Same shared-secret convention as the webhook route (?secret=...) — these routes trigger
  // real Monday writes (archive) and queue floods (sweep), so they are never left open.
  secret?: string;
}

// Every duty doubles as an authenticated HTTP route so a human (or their AI assistant) can
// trigger it on demand and read a JSON report — the docs/20 §5.3 runbook surface. The cron
// schedule calls the same functions; there is no cron-only behavior to reverse-engineer.
export function createCustodianApp(deps: CustodianAppDeps) {
  const app = new Hono();

  const authorized = (secret: string | undefined) => !deps.secret || secret === deps.secret;

  app.get('/custodian/status', async (c) => {
    if (!authorized(c.req.query('secret'))) return c.json({ ok: false }, 401);
    return c.json({ ok: true, lastRuns: await deps.lastRuns() });
  });

  app.post('/custodian/run/:duty', async (c) => {
    if (!authorized(c.req.query('secret'))) return c.json({ ok: false }, 401);
    const duty = c.req.param('duty');
    if (!(DUTIES as readonly string[]).includes(duty)) {
      return c.json({ ok: false, error: `unknown duty "${duty}" — one of: ${DUTIES.join(', ')}` }, 400);
    }
    const report = await deps.runDuty(duty as Duty);
    return c.json({ duty, ...report });
  });

  return app;
}
