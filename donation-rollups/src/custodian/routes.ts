import { Hono } from 'hono';
import { DUTIES, type Duty, type DutyOptions, type DutyReport } from './custodian';
import { secretsMatch } from '../secret';
import { runDisposition, type WriteMode } from '../flags';

export interface CustodianAppDeps {
  // `run` with live deps, `dry-run` with the write switch's recording proxies (writeSwitch.ts
  // custodianDepsFor) — never called when the mode says skip.
  runDuty(duty: Duty, opts: DutyOptions, disposition: 'run' | 'dry-run'): Promise<DutyReport>;
  lastRuns(): Promise<unknown>;
  // CUSTODIAN_SECRET, presented as `Authorization: Bearer <secret>` (issue #63) — its own
  // secret, not the webhook's: that one rides in Monday's webhook URL, so in Monday's config and
  // request logs. Checked the same constant-time, fail-closed way: an unset/empty secret
  // disables these routes entirely.
  secret?: string;
  // The write switch (flags.ts readWriteMode), read once per duty request — the same mode the
  // cron obeys, so `hold` can't be sidestepped by triggering a duty by hand.
  writeMode: () => Promise<WriteMode>;
}

// Every duty doubles as an authenticated HTTP route so a human (or their AI assistant) can
// trigger it on demand and read a JSON report — the docs/20 §5.3 runbook surface. The cron
// schedule calls the same functions; there is no cron-only behavior to reverse-engineer.
export function createCustodianApp(deps: CustodianAppDeps) {
  const app = new Hono();

  // Fail closed: an unset or empty secret must mean "nobody is authorized" — these routes
  // trigger real Monday writes (archive) and queue floods (sweep).
  // Only the Bearer scheme counts; a ?secret= query parameter is ignored, never a fallback.
  const authorized = (header: string | undefined) => {
    const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    return secretsMatch(presented, deps.secret);
  };

  app.get('/custodian/status', async (c) => {
    if (!(await authorized(c.req.header('Authorization')))) return c.json({ ok: false }, 401);
    return c.json({ ok: true, lastRuns: await deps.lastRuns() });
  });

  app.post('/custodian/run/:duty', async (c) => {
    if (!(await authorized(c.req.header('Authorization')))) return c.json({ ok: false }, 401);
    const duty = c.req.param('duty');
    if (!(DUTIES as readonly string[]).includes(duty)) {
      return c.json({ ok: false, error: `unknown duty "${duty}" — one of: ${DUTIES.join(', ')}` }, 400);
    }
    const opts: DutyOptions = {};
    if (c.req.query('all') === 'true') opts.all = true;
    if (c.req.query('force') === '1') opts.force = true;
    const since = c.req.query('since');
    if (since !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(since)) return c.json({ ok: false, error: 'since must be an ISO 8601 timestamp' }, 400);
      opts.since = since;
    }
    const mode = await deps.writeMode();
    const disposition = runDisposition(mode);
    // `hold` or an unreadable switch: refuse rather than half-run — 409 says "not now", and the
    // caller can retry once writes are `on` (or `off`, for a dry run).
    if (disposition === 'skip') return c.json({ ok: false, mode }, 409);
    const report = await deps.runDuty(duty as Duty, opts, disposition);
    return c.json({ duty, mode, ...report });
  });

  return app;
}
