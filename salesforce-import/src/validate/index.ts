import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { registerCommand } from '../commands.js';
import { loadConfig } from '../config.js';
import { dataPath, readNdjson, writeJson } from '../artifacts.js';
import type { ItemPayload } from '../transform/types.js';
import { Ledger } from '../load/ledger.js';

interface Check { name: string; ok: boolean; detail: string }

// Deterministic PRNG so the sample sheet is reproducible run-to-run.
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample<T>(rows: T[], n: number, rand: () => number): T[] {
  const pool = [...rows];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]!);
  return out;
}

const CATEGORY = (board: string): string | null =>
  board === 'organizations' ? 'organizations'
  : board.startsWith('people-') ? 'people'
  : board === 'donations' ? 'donations'
  : board === 'event-registrations' ? 'registrations'
  : board === 'affiliations' ? 'affiliations'
  : null;

export async function runValidate(args: string[]): Promise<number> {
  const cfg = loadConfig();
  const tolIdx = args.indexOf('--tolerance');
  const tol = tolIdx >= 0 ? Number(args[tolIdx + 1]) : 0;
  const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));
  const ledger = new Ledger();
  await ledger.load();
  const checks: Check[] = [];
  const near = (actual: number, expected: number) => Math.abs(actual - expected) <= tol;

  // 1. Ledger coverage.
  const missing = payloads.filter((p) => !ledger.has(p.sfId, p.board));
  checks.push({ name: 'ledger-coverage', ok: missing.length === 0,
    detail: missing.length === 0 ? `all ${payloads.length} payloads landed`
      : `${missing.length} payloads never landed (first: ${missing[0]!.board}/${missing[0]!.sfId})` });

  // 2. Link integrity — every payload link should have been written by load, or be explainable
  // by design (all its targets were deliberately never migrated, e.g. excluded contacts).
  let linksNotWritten = 0;
  let skippedByDesign = 0;
  let unresolvableTargets = 0;
  for (const p of payloads) {
    for (const link of p.links ?? []) {
      const resolvedCount = link.targetSfIds.filter((id) => ledger.itemId(id) !== undefined).length;
      unresolvableTargets += link.targetSfIds.length - resolvedCount;
      if (ledger.linkDone(p.sfId, link.column)) continue;
      if (resolvedCount > 0) linksNotWritten++;
      else skippedByDesign++; // zero resolvable targets — skipped by design, not a failure
    }
  }
  const ledgerFailureCount = ledger.failures().length;
  checks.push({ name: 'link-integrity', ok: linksNotWritten === 0 && ledgerFailureCount === 0,
    detail: `${linksNotWritten} links not written, ${unresolvableTargets} unresolvable targets ` +
      `(${skippedByDesign} skipped-by-design), ${ledgerFailureCount} ledger failures` });

  // 2b. Archive coverage — every donation flagged for archive-in-place actually archived.
  // Ledger-based (like everything here): items_page can't see archived items, so Monday-side
  // counting would under-report by exactly the archived set.
  const flagged = payloads.filter((p) => p.archive);
  const unarchived = flagged.filter((p) => !ledger.archivedDone(p.sfId) && ledger.has(p.sfId, p.board));
  checks.push({ name: 'archive-coverage', ok: unarchived.length === 0,
    detail: unarchived.length === 0 ? `all ${flagged.length} flagged donations archived`
      : `${unarchived.length} of ${flagged.length} flagged donations still active ` +
        `(first: ${unarchived[0]!.sfId})` });

  // 3. Reconciliation (doc 03 §7 — figures move while Funraise still syncs; freeze before final run).
  const r = cfg.reconciliation;
  const funraiseDonations = payloads.filter((p) =>
    p.board === 'donations' && !!p.columns['Funraise ID']);
  const cents = funraiseDonations.reduce((n, p) => n + Math.round(Number(p.columns['Amount'] ?? 0) * 100), 0);
  const recCheck = (name: string, actual: number, expected: number | undefined) => {
    if (expected === undefined) return;
    checks.push({ name, ok: near(actual, expected), detail: `actual ${actual} vs salesforce ${expected}` });
  };
  recCheck('recon-funraise-count', funraiseDonations.length, r['funraiseOpportunities']);
  recCheck('recon-funraise-cents', cents, r['funraiseTotalAmountCents']);
  const redactedSkips = existsSync(dataPath('extract', 'subscriptions.ndjson'))
    ? (await readNdjson<Record<string, unknown>>(dataPath('extract', 'subscriptions.ndjson')))
        .filter((s) => s['Name'] === 'Redacted').length
    : 0;
  recCheck('recon-subscriptions',
    payloads.filter((p) => p.board === 'recurring-gifts').length + redactedSkips, r['subscriptionsAll']);
  // Both platforms share event-registrations; reconcile each against its own Salesforce object.
  const sourceOf = (p: ItemPayload) => (p.columns['Source'] as { label?: string } | undefined)?.label;
  const registrations = payloads.filter((p) => p.board === 'event-registrations');
  recCheck('recon-registrations',
    registrations.filter((p) => sourceOf(p) === 'Funraise').length, r['eventRegistrations']);
  // Transform drops attendees Eventbrite itself deleted; add them back so the figure matches the org.
  const deletedAttendees = existsSync(dataPath('extract', 'eb4sf_attendees.ndjson'))
    ? (await readNdjson<Record<string, unknown>>(dataPath('extract', 'eb4sf_attendees.ndjson')))
        .filter((a) => a['eb4sf__Status__c'] === 'Deleted').length
    : 0;
  recCheck('recon-eventbrite-attendees',
    registrations.filter((p) => sourceOf(p) === 'Eventbrite').length + deletedAttendees, r['eventbriteAttendees']);
  recCheck('recon-organizations',
    payloads.filter((p) => p.board === 'organizations').length, r['organizations']);

  // 4. Stratified sample sheet (~300 rows, floor 30/category, proportional above, seeded PRNG).
  const byCategory = new Map<string, ItemPayload[]>();
  for (const p of payloads) {
    const cat = CATEGORY(p.board);
    if (!cat) continue;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(p);
  }
  const total = [...byCategory.values()].reduce((n, v) => n + v.length, 0);
  const rand = mulberry32(20260822);
  const lines = ['category,board,sfId,mondayItemId,name'];
  for (const [cat, rows] of byCategory) {
    const target = Math.min(rows.length, Math.max(30, Math.round((rows.length / Math.max(total, 1)) * 300)));
    for (const p of sample(rows, target, rand)) {
      lines.push([cat, p.board, p.sfId, ledger.itemId(p.sfId) ?? '',
        `"${p.name.replace(/"/g, '""')}"`].join(','));
    }
  }
  await writeJson(dataPath('validate', 'result.json'),
    { ok: checks.every((c) => c.ok), checks });
  await writeFile(dataPath('validate', 'sample.csv'), lines.join('\n') + '\n', 'utf8');

  for (const c of checks) console.log(`validate: ${c.ok ? 'OK  ' : 'FAIL'} ${c.name} — ${c.detail}`);
  return checks.every((c) => c.ok) ? 0 : 1;
}

registerCommand('validate', (args) => runValidate(args));
