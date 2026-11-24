import { describe, expect, it } from 'vitest';
import watchdog from '../../sync-watchdog/config/svbc.json';
import watchdogSandbox from '../../sync-watchdog/config/sandbox.json';
import production from './svbc.json';
import sandbox from './sandbox.json';

// Keeps the page's sync list in step with sync-watchdog's: every Worker the watchdog watches is
// shown or deliberately hidden, and every watched queue belongs to exactly one shown sync. Adding
// a Worker to the watchdog fails here until it gets a staff label (or a hiddenWorkers reason).

type Cfg = typeof production;
type Wd = { watched: Record<string, unknown>; queues: { name: string }[] };

function check(cfg: Cfg, wd: Wd, label: string) {
  const shown = cfg.syncs.map((s) => s.worker);
  const hidden = Object.keys(cfg.hiddenWorkers);
  for (const worker of Object.keys(wd.watched)) {
    expect(shown.includes(worker) || hidden.includes(worker), `${label}: ${worker} is watched but neither shown nor hidden`).toBe(true);
    expect(shown.includes(worker) && hidden.includes(worker), `${label}: ${worker} is both shown and hidden`).toBe(false);
  }
  for (const worker of shown) expect(worker in wd.watched, `${label}: ${worker} is shown but not watched`).toBe(true);
  expect(new Set(shown).size, `${label}: a worker is listed twice`).toBe(shown.length);
  for (const { name } of wd.queues) {
    const owners = cfg.syncs.filter((s) => s.queues.includes(name));
    expect(owners.length, `${label}: queue ${name} belongs to ${owners.length} syncs`).toBe(1);
  }
}

describe('sync coverage', () => {
  it('production matches sync-watchdog', () => check(production, watchdog as Wd, 'production'));
  it('sandbox matches sync-watchdog sandbox', () => check(sandbox, watchdogSandbox as Wd, 'sandbox'));
  it('every configured queue is one the production watchdog watches', () => {
    const watched = new Set((watchdog as Wd).queues.map((q) => q.name));
    for (const s of production.syncs) for (const q of s.queues) expect(watched.has(q), q).toBe(true);
  });
});
