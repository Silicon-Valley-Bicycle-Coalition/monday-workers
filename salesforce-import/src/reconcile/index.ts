import { existsSync } from 'node:fs';
import { registerCommand } from '../commands.js';
import { loadConfig } from '../config.js';
import { dataPath, readJson, readNdjson, writeJson, writeText } from '../artifacts.js';
import type { ItemPayload } from '../transform/types.js';
import type { BoardMap } from '../load/boards.js';
import { Ledger } from '../load/ledger.js';
import { MondayClient } from '../load/monday.js';
import { expectedGifts, fyOf, fyOrder, toCents, topDonors, totalsByFY, type Totals } from './expected.js';
import { GraphqlMondayReader, SF_ID_SOURCES, sfIdOf, type MondayReader, type ReadItem } from './monday.js';

// Post-load reconciliation gate (svbc-monday-migration#47). Where `validate` checks the load
// against its own ledger, this recomputes what SHOULD be on Monday from the frozen extract and
// compares it with what Monday itself reports:
//   1. extract → transform: the payloads being reconciled are the ones this extract produces
//   2. donations by fiscal year: count and Amount sum, Salesforce vs Monday
//   3. donations by Salesforce Id: the gifts behind any fiscal-year difference
//   4. every board: Salesforce source count vs Monday item count (duplicates, drops, strays)
//   5. top-N donors: Lifetime Giving from the extract vs the value on Monday (donation-rollups)
// Read-only against Monday. Exit 0 = GO, 1 = NO-GO.

interface Check { name: string; ok: boolean; detail: string }

const DONATIONS = 'donations';
const DONATION_COLUMNS = ['Amount', 'Date'];
const OWNER_COLUMNS = ['Lifetime Giving', 'Gift Count'];
const PRESENT = new Set(['active', 'archived']);
const SHOW = 5; // example ids listed per failure

export const money = (cents: number): string =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number): string => n.toLocaleString('en-US');
const signed = (n: number, fmt: (n: number) => string): string => (n > 0 ? `+${fmt(n)}` : n === 0 ? '0' : fmt(n));
const examples = (ids: string[]): string => (ids.length ? ` (e.g. ${ids.slice(0, SHOW).join(', ')})` : '');

interface BoardRead { items: ReadItem[]; active: number; archived: number; sfIdReadable: boolean }

/**
 * Every item on the board that Monday still has: the active ones by scanning, plus any the
 * ledger created that the scan didn't see, read back by id — Monday's API can list only active
 * items, so the ledger is the one index to archived ones. Only item ids come from the ledger;
 * every value compared (board, state, Salesforce Id, Amount, Date…) is read from Monday.
 */
async function readBoard(reader: MondayReader, boardId: number, extra: string[], ledgerItemIds: string[]):
  Promise<BoardRead> {
  const titles = await reader.columns(boardId);
  const cols: Record<string, string> = {};
  for (const t of [...SF_ID_SOURCES, ...extra]) { const id = titles.get(t); if (id) cols[t] = id; }
  const sfIdReadable = SF_ID_SOURCES.some((t) => cols[t]);
  const active = await reader.scan(boardId, cols);
  const seen = new Set(active.map((i) => i.id));
  const unseen = ledgerItemIds.filter((id) => !seen.has(id));
  const rest = (unseen.length ? await reader.byIds(unseen, cols) : [])
    .filter((i) => i.boardId === String(boardId) && PRESENT.has(i.state));
  return { items: [...active, ...rest], active: active.length,
    archived: rest.filter((i) => i.state === 'archived').length, sfIdReadable };
}

function groupBySfId(items: ReadItem[]): { bySfId: Map<string, ReadItem[]>; untagged: number } {
  const bySfId = new Map<string, ReadItem[]>();
  let untagged = 0;
  for (const item of items) {
    const sfId = sfIdOf(item);
    if (!sfId) { untagged++; continue; }
    (bySfId.get(sfId) ?? bySfId.set(sfId, []).get(sfId)!).push(item);
  }
  return { bySfId, untagged };
}

export async function runReconcile(args: string[], deps: { reader?: MondayReader } = {}): Promise<number> {
  const cfg = loadConfig();
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const topN = Number(flag('--top') ?? 25);
  if (!Number.isInteger(topN) || topN < 0) { console.error('reconcile: --top must be a non-negative integer'); return 2; }
  const boardsPath = flag('--boards') ?? dataPath('load', 'boards.json');

  let reader = deps.reader;
  if (!reader) {
    const token = process.env['MONDAY_API_TOKEN'];
    // 2, like a bad --top: 1 means NO-GO, and a missing token is a setup error, not a finding.
    if (!token) { console.error('reconcile: MONDAY_API_TOKEN not set'); return 2; }
    reader = new GraphqlMondayReader(new MondayClient({ apiUrl: cfg.monday.apiUrl, token }));
  }

  // ── Expected, from the frozen extract ──────────────────────────────────────────────────────
  const [opportunities, cnp] = await Promise.all([
    readNdjson<Record<string, unknown>>(dataPath('extract', 'opportunities.ndjson')),
    readNdjson<Record<string, unknown>>(dataPath('extract', 'clickpledge_transactions.ndjson'))]);
  const manifestPath = dataPath('extract', 'manifest.json');
  const extractedAt = existsSync(manifestPath)
    ? (await readJson<{ extractedAt?: string }>(manifestPath)).extractedAt ?? 'unknown' : 'unknown';
  const expected = expectedGifts(opportunities, cnp);
  const expectedById = new Map(expected.gifts.map((g) => [g.sfId, g]));
  const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));
  const boards = await readJson<BoardMap>(boardsPath);
  const ledger = new Ledger();
  await ledger.load();

  const checks: Check[] = [];
  const sections: string[] = [];

  // 1. The transform being reconciled came from this extract (a stale payloads file would make
  // every per-board and top-donor figure below meaningless).
  const payloadGiftIds = new Set(payloads.filter((p) => p.board === DONATIONS).map((p) => p.sfId));
  const notTransformed = [...expectedById.keys()].filter((id) => !payloadGiftIds.has(id));
  const notInExtract = [...payloadGiftIds].filter((id) => !expectedById.has(id));
  checks.push({ name: 'extract-matches-transform', ok: notTransformed.length === 0 && notInExtract.length === 0,
    detail: `${num(expected.gifts.length)} gifts in the extract (${num(opportunities.length)} Opportunities + ` +
      `${num(expected.cnpUnique)} Click & Pledge; ${num(expected.cnpOverlap)} C&P already Opportunities), ` +
      `${num(payloadGiftIds.size)} donation payloads — ${notTransformed.length} missing from transform` +
      `${examples(notTransformed)}, ${notInExtract.length} not in extract${examples(notInExtract)}` });

  // ── Actual, from Monday ────────────────────────────────────────────────────────────────────
  const boardKeys = [...new Set(payloads.map((p) => p.board))].sort();
  const reads = new Map<string, BoardRead>();
  const boardRows: string[] = [];
  for (const key of boardKeys) {
    const board = boards[key];
    const expectedIds = new Set(payloads.filter((p) => p.board === key).map((p) => p.sfId));
    if (!board) {
      checks.push({ name: `board-${key}`, ok: false, detail: `no board id for "${key}" in ${boardsPath}` });
      continue;
    }
    const extra = key === DONATIONS ? DONATION_COLUMNS : OWNER_COLUMNS;
    const read = await readBoard(reader, board.boardId, extra, ledger.successesFor(key).map((s) => s.itemId));
    reads.set(key, read);
    console.log(`reconcile: read ${key} — ${num(read.active)} active, ${num(read.archived)} archived`);
    const onMonday = `${num(read.items.length)} on Monday (${num(read.active)} active + ${num(read.archived)} archived)`;
    if (!read.sfIdReadable) {
      const ok = read.items.length === expectedIds.size;
      checks.push({ name: `board-${key}`, ok, detail: `${onMonday} vs ${num(expectedIds.size)} from Salesforce — ` +
        'count only: board has no Salesforce ID or Salesforce Debug column' });
      boardRows.push(`| ${key} | ${num(expectedIds.size)} | ${num(read.items.length)} | ${num(read.archived)} | – | – | – | – | ${ok ? 'OK' : 'FAIL'} |`);
      continue;
    }
    const { bySfId, untagged } = groupBySfId(read.items);
    const missing = [...expectedIds].filter((id) => !bySfId.has(id));
    const duplicated = [...bySfId].filter(([, items]) => items.length > 1).map(([id]) => id);
    const unexpected = [...bySfId.keys()].filter((id) => !expectedIds.has(id));
    const tagged = read.items.length - untagged;
    const ok = missing.length === 0 && duplicated.length === 0 && unexpected.length === 0;
    checks.push({ name: `board-${key}`, ok,
      detail: `${onMonday} vs ${num(expectedIds.size)} from Salesforce — ${missing.length} missing${examples(missing)}, ` +
        `${duplicated.length} duplicated${examples(duplicated)}, ${unexpected.length} not from this extract` +
        `${examples(unexpected)}; ${untagged} without a Salesforce Id (added on Monday, not compared)` });
    boardRows.push(`| ${key} | ${num(expectedIds.size)} | ${num(tagged)} | ${num(read.archived)} | ${missing.length} | ` +
      `${duplicated.length} | ${unexpected.length} | ${untagged} | ${ok ? 'OK' : 'FAIL'} |`);
  }

  // 2 + 3. Donations by fiscal year, and the individual gifts behind any difference.
  const donations = reads.get(DONATIONS);
  if (donations?.sfIdReadable) {
    const { bySfId, untagged } = groupBySfId(donations.items);
    // Every imported item counts — a duplicate adds its Amount twice, exactly the error to catch.
    const actualGifts = [...bySfId.values()].flat()
      .map((i) => ({ fy: fyOf(i.values['Date'] || null), cents: toCents(i.values['Amount'] || 0) }));
    const want = totalsByFY(expected.gifts);
    const got = totalsByFY(actualGifts);
    const zero: Totals = { count: 0, cents: 0 };
    const fys = [...new Set([...want.keys(), ...got.keys()])].sort(fyOrder);
    const rows: string[] = [];
    const badFys: string[] = [];
    let sum = { sfCount: 0, sfCents: 0, mCount: 0, mCents: 0 };
    for (const fy of fys) {
      const w = want.get(fy) ?? zero, g = got.get(fy) ?? zero;
      const ok = w.count === g.count && w.cents === g.cents;
      if (!ok) badFys.push(fy);
      sum = { sfCount: sum.sfCount + w.count, sfCents: sum.sfCents + w.cents,
        mCount: sum.mCount + g.count, mCents: sum.mCents + g.cents };
      rows.push(`| ${fy === '(undated)' ? fy : `FY${fy}`} | ${num(w.count)} | ${num(g.count)} | ${signed(g.count - w.count, num)} | ` +
        `${money(w.cents)} | ${money(g.cents)} | ${signed(g.cents - w.cents, money)} | ${ok ? 'OK' : 'FAIL'} |`);
    }
    rows.push(`| **Total** | **${num(sum.sfCount)}** | **${num(sum.mCount)}** | **${signed(sum.mCount - sum.sfCount, num)}** | ` +
      `**${money(sum.sfCents)}** | **${money(sum.mCents)}** | **${signed(sum.mCents - sum.sfCents, money)}** | ` +
      `${badFys.length ? 'FAIL' : 'OK'} |`);
    checks.push({ name: 'donations-by-fiscal-year', ok: badFys.length === 0,
      detail: badFys.length === 0
        ? `${fys.length} fiscal years, ${num(sum.sfCount)} gifts, ${money(sum.sfCents)} — all match`
        : `${badFys.length} of ${fys.length} fiscal years differ (${badFys.slice(0, SHOW).join(', ')}` +
          `${badFys.length > SHOW ? ', …' : ''}); Monday ${num(sum.mCount)} gifts ${money(sum.mCents)} vs ` +
          `Salesforce ${num(sum.sfCount)} ${money(sum.sfCents)}` });
    sections.push('## Donations by fiscal year (July–June)\n\n' +
      '| Fiscal year | Salesforce gifts | Monday gifts | Δ | Salesforce amount | Monday amount | Δ | |\n' +
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n' + rows.join('\n') +
      (untagged ? `\n\n${num(untagged)} Donations items carry no Salesforce Id (created on Monday after the ` +
        'load, e.g. by a live sync) and are left out of these totals.' : ''));

    // Gifts that landed once but with a different Amount or fiscal year than Salesforce has.
    const amountDiffs: string[] = [], fyDiffs: string[] = [];
    for (const [sfId, items] of bySfId) {
      const want1 = expectedById.get(sfId);
      if (!want1 || items.length !== 1) continue; // missing/duplicated/stray: reported per board
      const item = items[0]!;
      if (toCents(item.values['Amount'] || 0) !== want1.cents) amountDiffs.push(sfId);
      if (fyOf(item.values['Date'] || null) !== want1.fy) fyDiffs.push(sfId);
    }
    checks.push({ name: 'donations-by-salesforce-id', ok: amountDiffs.length === 0 && fyDiffs.length === 0,
      detail: `${amountDiffs.length} gifts with a different Amount${examples(amountDiffs)}, ` +
        `${fyDiffs.length} dated into a different fiscal year${examples(fyDiffs)} ` +
        '(missing/duplicated gifts are under board-donations)' });
  } else if (donations) {
    checks.push({ name: 'donations-by-fiscal-year', ok: false,
      detail: 'Donations board has no Salesforce ID or Salesforce Debug column — cannot attribute items to gifts' });
  }

  sections.push('## Items per board\n\n' +
    '| Board | Salesforce | Monday | of which archived | Missing | Duplicated | Not from extract | No Salesforce Id | |\n' +
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n' + boardRows.join('\n'));

  // 5. Top-N donors: extract-derived Lifetime Giving vs what's on Monday now.
  if (topN > 0) {
    const top = topDonors(payloads, topN);
    const grouped = new Map([...reads].map(([key, read]) => [key, groupBySfId(read.items).bySfId]));
    const rows: string[] = [];
    const bad: string[] = [];
    for (const [i, d] of top.entries()) {
      const items = grouped.get(d.board)?.get(d.sfId) ?? [];
      const item = items.length === 1 ? items[0]! : undefined;
      const mCents = item ? toCents(item.values['Lifetime Giving'] || 0) : 0;
      const mCount = item ? Number(item.values['Gift Count'] || 0) : 0;
      const ok = !!item && mCents === d.lifetimeCents && mCount === d.giftCount;
      if (!ok) bad.push(d.sfId);
      const where = items.length === 0 ? 'not on Monday' : items.length > 1 ? `${items.length} items` : '';
      rows.push(`| ${i + 1} | ${d.name.replace(/\|/g, '\\|')} | ${d.board} | ${d.sfId} | ${money(d.lifetimeCents)} | ` +
        `${item ? money(mCents) : where} | ${item ? signed(mCents - d.lifetimeCents, money) : '–'} | ` +
        `${d.giftCount} / ${item ? mCount : '–'} | ${ok ? 'OK' : 'FAIL'} |`);
    }
    checks.push({ name: `top-${topN}-donors`, ok: bad.length === 0,
      detail: bad.length === 0 ? `all ${top.length} match Lifetime Giving and Gift Count`
        : `${bad.length} of ${top.length} differ${examples(bad)}` });
    sections.push(`## Top ${top.length} donors — Lifetime Giving\n\n` +
      '| # | Donor | Board | Salesforce Id | Salesforce | Monday | Δ | Gifts SF / Monday | |\n' +
      '| ---: | --- | --- | --- | ---: | ---: | ---: | --- | --- |\n' + rows.join('\n'));
  }

  // ── Report ─────────────────────────────────────────────────────────────────────────────────
  const ok = checks.every((c) => c.ok);
  const report = [
    `# Post-load reconciliation — ${ok ? 'GO' : 'NO-GO'}`,
    '',
    `Extract ${extractedAt} · ${num(payloads.length)} payloads · boards from ${boardsPath} · run ${new Date().toISOString()}`,
    '',
    '| Check | Result | Detail |', '| --- | --- | --- |',
    ...checks.map((c) => `| ${c.name} | ${c.ok ? 'PASS' : '**FAIL**'} | ${c.detail.replace(/\|/g, '\\|')} |`),
    '', ...sections.flatMap((s) => [s, '']),
  ].join('\n');
  await writeJson(dataPath('reconcile', 'result.json'), { ok, extractedAt, checks });
  await writeText(dataPath('reconcile', 'report.md'), report);

  for (const c of checks) console.log(`reconcile: ${c.ok ? 'OK  ' : 'FAIL'} ${c.name} — ${c.detail}`);
  console.log(`reconcile: ${ok ? 'GO' : 'NO-GO'} — full report in ${dataPath('reconcile', 'report.md')}`);
  return ok ? 0 : 1;
}

registerCommand('reconcile', (args) => runReconcile(args));
