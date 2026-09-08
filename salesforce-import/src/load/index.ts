import { registerCommand } from '../commands.js';
import { loadConfig } from '../config.js';
import { dataPath, readNdjson } from '../artifacts.js';
import type { ItemPayload } from '../transform/types.js';
import { fiscalYearLoadOrder } from '../transform/schedule.js';
import { MondayClient } from './monday.js';
import { Ledger } from './ledger.js';
import { ensureBoards, COLUMN_TYPES } from './boards.js';
import { formatColumnValue } from './columnValues.js';

// Donations load LAST among linked boards, in a per-fiscal-year create → link → archive loop
// (docs/20 in the private planning repo): the single Donations board can't hold its full
// history active at once — Monday's 10k ceiling counts active items only, and archived items
// reject all writes — so each fiscal year's items must be created, linked (in BOTH directions,
// including event-registrations' Payment links pointing at them), and only then archived.
// That's why event-registrations precede donations here. Affiliations link to People and
// Organizations (must exist first) and are linked *from* Event Registrations and Donations
// (which load later), so this position is the only valid one.
const ORDER = ['organizations', 'people-live', 'people-historical', 'affiliations', 'campaigns',
  'recurring-gifts', 'events', 'event-registrations', 'donations', 'volunteers', 'activities'];

function boardOrder(keys: string[]): string[] {
  return ORDER.filter((k) => keys.includes(k));
}

const payloadFY = (p: ItemPayload): string => String(p.columns['Fiscal Year Ending'] ?? '');

// targetSfIds mirrors targetIds — the resolved TARGET items' Salesforce ids — so a failed
// link can be ledgered against its targets too (the archive gate below must not archive a
// donation that a failed incoming link still points at).
interface LinkTask { boardId: number; itemId: string; colId: string; targetIds: number[];
  targetSfIds: string[]; sfId: string; column: string }
// A payload link that can't be written yet because its targets are donations that phase 3
// hasn't created (and must link before archiving).
interface DeferredLink { key: string; payload: ItemPayload; link: { column: string; targetSfIds: string[] } }

export async function runLoad(args: string[], deps: { client?: MondayClient } = {}): Promise<number> {
  const cfg = loadConfig();
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

  const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));

  const byBoard = new Map<string, ItemPayload[]>();
  for (const p of payloads) {
    if (!byBoard.has(p.board)) byBoard.set(p.board, []);
    if (byBoard.get(p.board)!.length < limit) byBoard.get(p.board)!.push(p);
  }
  const keys = boardOrder([...byBoard.keys()]);

  if (dryRun) {
    for (const key of keys) {
      const items = byBoard.get(key)!;
      const links = items.reduce((n, p) => n + (p.links?.length ?? 0), 0);
      const toArchive = items.filter((p) => p.archive).length;
      console.log(`load[dry-run]: ${key} → ${items.length} items, ${links} links` +
        (toArchive > 0 ? `, ${toArchive} to archive in place` : ''));
    }
    return 0;
  }

  const token = process.env['MONDAY_API_TOKEN'];
  if (!token) { console.error('load: MONDAY_API_TOKEN not set'); return 1; }
  const client = deps.client ?? new MondayClient({ apiUrl: cfg.monday.apiUrl, token });
  const ledger = new Ledger();
  await ledger.load();

  const needed = new Map<string, Set<string>>();
  for (const key of keys) {
    const set = new Set<string>();
    for (const p of byBoard.get(key)!) {
      for (const t of Object.keys(p.columns)) set.add(t);
      for (const l of p.links ?? []) set.add(l.column);
    }
    needed.set(key, set);
  }
  const boards = await ensureBoards(client, cfg, keys, needed);

  const createItems = async (key: string, items: ItemPayload[]): Promise<void> => {
    const board = boards[key]!;
    for (const p of items) {
      if (ledger.has(p.sfId, key)) continue;
      const colValues: Record<string, unknown> = {};
      for (const [title, value] of Object.entries(p.columns)) {
        if (value === null || value === undefined || value === '') continue;
        const id = board.columns[title];
        if (!id) throw new Error(`load: board ${key} has no column id for "${title}"`);
        const formatted = formatColumnValue(COLUMN_TYPES[title] ?? 'text', value);
        if (formatted === null) continue;
        colValues[id] = formatted;
      }
      try {
        const res = await client.gql<{ create_item: { id: string } }>(
          `mutation ($boardId: ID!, $itemName: String!, $cols: JSON, $create: Boolean!) {
             create_item (board_id: $boardId, item_name: $itemName, column_values: $cols,
               create_labels_if_missing: $create) { id } }`,
          { boardId: String(board.boardId), itemName: p.name, cols: JSON.stringify(colValues), create: true });
        await ledger.recordSuccess({ sfId: p.sfId, board: key, itemId: res.create_item.id });
      } catch (err) {
        await ledger.recordFailure({ sfId: p.sfId, board: key, error: String(err) });
        console.error(`load: FAILED ${key}/${p.sfId}: ${String(err)}`);
      }
    }
  };

  // Link machinery. Sequential linking measured ~40h for the real dataset's 94k links, so a
  // small worker pool runs LINK_CONCURRENCY mutations in flight; each link still ledgers
  // individually and per-call retry/backoff lives in the client.
  const LINK_CONCURRENCY = 6;
  let skippedLinks = 0;
  let partialLinks = 0;
  const buildLinkTasks = (entries: DeferredLink[]): LinkTask[] => {
    const tasks: LinkTask[] = [];
    for (const { key, payload: p, link } of entries) {
      const board = boards[key]!;
      const itemId = ledger.itemId(p.sfId);
      if (!itemId) continue;
      if (ledger.linkDone(p.sfId, link.column)) continue;
      const resolved = link.targetSfIds
        .map((sfId) => ({ sfId, targetItemId: ledger.itemId(sfId) }))
        .filter((t): t is { sfId: string; targetItemId: string } => t.targetItemId !== undefined);
      if (resolved.length === 0) { skippedLinks++; continue; }
      if (resolved.length < link.targetSfIds.length) partialLinks++;
      const colId = board.columns[link.column];
      if (!colId) throw new Error(`load: board ${key} missing connect column "${link.column}"`);
      tasks.push({ boardId: board.boardId, itemId, colId,
        targetIds: resolved.map((t) => Number(t.targetItemId)),
        targetSfIds: resolved.map((t) => t.sfId), sfId: p.sfId, column: link.column });
    }
    return tasks;
  };
  // sfIds whose links were (re)written during THIS run — an item that had a link retried
  // after a prior run archived it must be re-archived below, ledger notwithstanding.
  const linkedThisRun = new Set<string>();
  const runLinkTasks = async (linkTasks: LinkTask[]): Promise<void> => {
    let nextTask = 0;
    const linkWorker = async (): Promise<void> => {
      while (nextTask < linkTasks.length) {
        const t = linkTasks[nextTask++]!;
        try {
          await client.gql(
            `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!, $create: Boolean!) {
               change_multiple_column_values (board_id: $boardId, item_id: $itemId, column_values: $cols,
                 create_labels_if_missing: $create) { id } }`,
            { boardId: String(t.boardId), itemId: t.itemId,
              cols: JSON.stringify({ [t.colId]: { item_ids: t.targetIds } }), create: true });
          await ledger.recordLink(t.sfId, t.column);
          linkedThisRun.add(t.sfId);
          // Targets count too: a retried incoming link means its target was unarchived for
          // the write to stick, so the re-archive check below must see it as touched.
          for (const target of t.targetSfIds) linkedThisRun.add(target);
        } catch (err) {
          await ledger.recordLinkFailure({ sfId: t.sfId, column: t.column, error: String(err),
            targetSfIds: t.targetSfIds });
        }
      }
    };
    await Promise.all(Array.from({ length: LINK_CONCURRENCY }, () => linkWorker()));
  };

  const donations = byBoard.get('donations') ?? [];
  const donationFYBySfId = new Map(donations.map((p) => [p.sfId, payloadFY(p)]));

  // Phase 1: create items for every board except donations.
  for (const key of keys) {
    if (key === 'donations') continue;
    await createItems(key, byBoard.get(key)!);
    console.log(`load: ${key} phase-1 complete`);
  }

  // Phase 2: links between non-donation boards. Links pointing INTO this run's donations
  // (event-registrations' Payment) are deferred into phase 3, where they're written after the
  // target fiscal year's items exist and before that year archives.
  const phase2: DeferredLink[] = [];
  const deferredByFY = new Map<string, DeferredLink[]>();
  for (const key of keys) {
    if (key === 'donations') continue;
    for (const p of byBoard.get(key)!) {
      for (const link of p.links ?? []) {
        const targetFY = link.targetSfIds.map((id) => donationFYBySfId.get(id)).find((fy) => fy !== undefined);
        if (targetFY === undefined) { phase2.push({ key, payload: p, link }); continue; }
        if (!deferredByFY.has(targetFY)) deferredByFY.set(targetFY, []);
        deferredByFY.get(targetFY)!.push({ key, payload: p, link });
      }
    }
  }
  await runLinkTasks(buildLinkTasks(phase2));
  console.log('load: phase-2 links complete');

  // Phase 3: donations, per fiscal year, oldest first — create, link both directions, then
  // archive years beyond the retention window. Archived items reject every later write, so
  // this ordering is mandatory, not stylistic.
  if (donations.length > 0) {
    const byFY = new Map<string, ItemPayload[]>();
    for (const p of donations) {
      const fy = payloadFY(p);
      if (!byFY.has(fy)) byFY.set(fy, []);
      byFY.get(fy)!.push(p);
    }
    for (const fy of fiscalYearLoadOrder(byFY.keys())) {
      const group = byFY.get(fy)!;
      await createItems('donations', group);
      await runLinkTasks(buildLinkTasks([
        ...group.flatMap((p) => (p.links ?? []).map((link) => ({ key: 'donations', payload: p, link }))),
        ...(deferredByFY.get(fy) ?? []),
      ]));
      deferredByFY.delete(fy);
      // Never archive an item whose links didn't land — archived items reject all writes, so
      // archiving would strand the retry behind a UI-only unarchive (bit for real: a network
      // blip during FY2025's links left 5 archived gifts with no Donor link, 2026-08-28).
      // "Its links" means both directions: a failed link is ledgered under its SOURCE's sfId
      // (e.g. an event-registration whose Payment points INTO a donation), so the gate must
      // also block every TARGET of a pending link, not just payloads that are themselves the
      // source. Pre-targetSfIds ledger entries have no target list — those can only gate by
      // source, same as before.
      const pendingLinkSfIds = new Set(
        ledger.failures().filter((f) => f.board.startsWith('link:'))
          .flatMap((f) => [f.sfId, ...(f.targetSfIds ?? [])]));
      const toArchive = group.filter((p) => p.archive);
      let archivedCount = 0, deferredCount = 0;
      for (const p of toArchive) {
        // Re-archive when a link was rewritten this run (the user unarchived it for the retry).
        if (ledger.archivedDone(p.sfId) && !linkedThisRun.has(p.sfId)) { archivedCount++; continue; }
        const itemId = ledger.itemId(p.sfId);
        if (!itemId) continue; // creation failed above; already ledgered as a failure
        if (pendingLinkSfIds.has(p.sfId)) {
          deferredCount++;
          console.warn(`load: NOT archiving donations/${p.sfId} — links still unresolved; ` +
            `fix links (re-run load), then it archives on the next run`);
          continue;
        }
        try {
          await client.gql(`mutation ($id: ID!) { archive_item (item_id: $id) { id } }`, { id: itemId });
          await ledger.recordArchive(p.sfId);
          archivedCount++;
        } catch (err) {
          await ledger.recordArchiveFailure(p.sfId, String(err));
        }
      }
      console.log(`load: donations FY${fy || '(undated)'} — ${group.length} items, ` +
        `${archivedCount} archived` + (deferredCount > 0 ? `, ${deferredCount} archive-deferred` : ''));
    }
    console.log('load: donations phase-3 complete');
  }
  // Deferred links whose target donations weren't in this run's payload set (e.g. created by
  // a previous run) — attempt normally; unresolvable targets count as skipped as usual.
  const deferredLeftover = [...deferredByFY.values()].flat();
  if (deferredLeftover.length > 0) await runLinkTasks(buildLinkTasks(deferredLeftover));

  if (skippedLinks > 0) console.warn(`load: ${skippedLinks} links skipped (target not migrated)`);
  if (partialLinks > 0) console.warn(`load: ${partialLinks} links wrote a partial set of targets ` +
    `(some target items not yet migrated)`);

  const failures = ledger.failures();
  if (failures.length > 0) {
    console.error(`load: ${failures.length} unresolved failures — re-run "load" to retry just these`);
    for (const f of failures.slice(0, 20)) console.error(`  ${f.board}/${f.sfId}: ${f.error}`);
    return 1;
  }
  console.log('load: complete, no unresolved failures');
  return 0;
}

registerCommand('load', (args) => runLoad(args));
