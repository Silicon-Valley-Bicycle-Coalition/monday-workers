import { registerCommand } from '../commands.js';
import { loadConfig } from '../config.js';
import { dataPath, readNdjson, writeJson } from '../artifacts.js';
import type { ItemPayload } from '../transform/types.js';
import { fiscalYearLoadOrder } from '../transform/schedule.js';
import { AmbiguousWriteError, MondayClient } from './monday.js';
import { Ledger } from './ledger.js';
import { ensureBoards, COLUMN_TYPES } from './boards.js';
import { formatColumnValue } from './columnValues.js';
import { SF_ID_COLUMN, findItemIdsBySfId, scanBoardSfIds } from './lookup.js';
import { ComplexityGate, createBatch, runPool, type CreateEntry, type CreateOutcome } from './batch.js';
import { isLegacySequential, parseLoadOptions } from './options.js';
import { planInlineLinks, type InlineContext, type InlineLink } from './inline.js';
import { estimateLoad, formatEstimate } from './estimate.js';

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

// Link mutations in flight. Sequential linking measured ~40h for the real dataset's 94k links,
// which is why links already ran in a small pool before #22.
const LINK_CONCURRENCY = 6;

// How many times an ambiguous create_item failure (see AmbiguousWriteError) is re-attempted
// after confirming by lookup that the earlier attempt didn't land.
const CREATE_ATTEMPTS = 3;

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
  if (!(limit > 0)) {
    console.error(`load: --limit needs a positive number (got "${args[limitIdx + 1] ?? ''}")`);
    return 1;
  }
  const opts = parseLoadOptions(args, cfg.load);
  if (typeof opts === 'string') { console.error(opts); return 1; }

  const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));

  const byBoard = new Map<string, ItemPayload[]>();
  for (const p of payloads) {
    if (!byBoard.has(p.board)) byBoard.set(p.board, []);
    if (byBoard.get(p.board)!.length < limit) byBoard.get(p.board)!.push(p);
  }
  const keys = boardOrder([...byBoard.keys()]);
  // Every sfId this run is expected to create. A link target outside this set was deliberately
  // never migrated (skipped by design); one inside it that has no item yet is PENDING — its
  // create failed or hasn't run — and must hold back archiving until it lands.
  const expectedSfIds = new Set([...byBoard.values()].flat().map((p) => p.sfId));

  if (dryRun) {
    for (const key of keys) {
      const items = byBoard.get(key)!;
      const links = items.reduce((n, p) => n + (p.links?.length ?? 0), 0);
      const toArchive = items.filter((p) => p.archive).length;
      console.log(`load[dry-run]: ${key} → ${items.length} items, ${links} links` +
        (toArchive > 0 ? `, ${toArchive} to archive in place` : ''));
    }
    // #22 measurement: old vs new request counts and a wall-clock estimate. The latency default
    // is the measured pre-#22 rate (~40 h for ~94k sequential mutations ≈ 1.53 s each); the
    // per-alias cost is a guess until a sandbox batch run measures it.
    const num = (flag: string, fallback: number): number => {
      const i = args.indexOf(flag);
      const n = i >= 0 ? Number(args[i + 1]) : fallback;
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const latencyMs = num('--latency-ms', 1530);
    const estimate = estimateLoad([...byBoard.values()].flat(), keys,
      { batchSize: opts.batchSize, inlineLinks: opts.inlineLinks });
    console.log(formatEstimate(estimate, { latencyMs, aliasMs: num('--alias-ms', latencyMs / 2),
      concurrency: opts.concurrency, linkConcurrency: LINK_CONCURRENCY, batchSize: opts.batchSize }));
    return 0;
  }

  const token = process.env['MONDAY_API_TOKEN'];
  if (!token) { console.error('load: MONDAY_API_TOKEN not set'); return 1; }
  const client = deps.client ?? new MondayClient({ apiUrl: cfg.monday.apiUrl, token });
  const ledger = new Ledger();
  await ledger.load();

  const needed = new Map<string, Set<string>>();
  for (const key of keys) {
    const set = new Set<string>([SF_ID_COLUMN]);
    for (const p of byBoard.get(key)!) {
      for (const t of Object.keys(p.columns)) set.add(t);
      for (const l of p.links ?? []) set.add(l.column);
    }
    needed.set(key, set);
  }
  // A column rename (e.g. the 2026-09 Email → Personal Email rename) only touches the column
  // title, never rewrites pre-existing items — so a ledger that already has items for a
  // just-renamed board is a partial re-run mixing old- and new-semantics data. Detect and warn;
  // the only fix is a full re-create (delete data/load/).
  const renamedBoardKeys = new Set<string>();
  const createdBoardKeys = new Set<string>();
  const boards = await ensureBoards(client, cfg, keys, needed,
    (boardKey) => { renamedBoardKeys.add(boardKey); },
    (boardKey) => { createdBoardKeys.add(boardKey); });
  for (const key of renamedBoardKeys) {
    if (ledger.hasAnyFor(key)) {
      console.warn(`load: ${key} had a column renamed this run and the ledger already holds items ` +
        `for it from a previous run — those items still carry the old column's values under the new ` +
        `title (mixed semantics). Delete data/load/ and re-run a full re-create.`);
    }
  }

  const report = {
    startedAt: new Date().toISOString(),
    created: {} as Record<string, number>, adopted: {} as Record<string, number>,
    createFailed: {} as Record<string, number>,
    // Items Monday holds more than once for one Salesforce Id — never auto-deleted; the first
    // is ledgered and the rest are listed here for a human to remove.
    duplicates: [] as { board: string; sfId: string; itemIds: string[] }[],
    untaggedItems: {} as Record<string, number>,
    // Post-create duplicate read-backs that errored (batched mode) — each one fails the run.
    readBackFailed: [] as { where: string; error: string }[],
    // inline: set inside create_item and confirmed by its response (#22); inlineUnconfirmed:
    // sent inline but not echoed back, so left to the link pass (counted again in `written`).
    // inlineRejected: Monday rejected the create while it carried them, so the item was created
    // without them and the link pass wrote them.
    links: { written: 0, inline: 0, inlineUnconfirmed: 0, inlineRejected: 0, partial: 0, pending: 0,
      skippedByDesign: 0, failed: 0 },
    archive: { archived: 0, deferred: 0, failed: 0 },
  };
  const bump = (m: Record<string, number>, key: string) => { m[key] = (m[key] ?? 0) + 1; };

  // Adopt items Monday already holds that the ledger doesn't know about — a create whose response
  // was lost, or a crash between create_item and the ledger append. Only boards that existed
  // before this run and still have unledgered payloads need the scan.
  for (const key of keys) {
    if (createdBoardKeys.has(key)) continue;
    const unledgered = byBoard.get(key)!.filter((p) => !ledger.has(p.sfId, key));
    if (unledgered.length === 0) continue;
    const board = boards[key]!;
    const scan = await scanBoardSfIds(client, board.boardId, board.columns[SF_ID_COLUMN]!);
    if (scan.untagged > 0) report.untaggedItems[key] = scan.untagged;
    for (const p of unledgered) {
      const itemIds = scan.bySfId.get(p.sfId);
      if (!itemIds?.length) continue;
      if (itemIds.length > 1) report.duplicates.push({ board: key, sfId: p.sfId, itemIds });
      await ledger.recordSuccess({ sfId: p.sfId, board: key, itemId: itemIds[0]! });
      bump(report.adopted, key);
    }
    if (report.adopted[key]) {
      console.warn(`load: ${key} — adopted ${report.adopted[key]} items already on Monday but missing ` +
        `from the ledger (lost create response or crash); not re-creating them`);
    }
  }

  // Column values for one payload's create_item, Salesforce ID first. Throws (before anything is
  // sent) when the board lacks a column the payload needs.
  const buildColValues = (key: string, p: ItemPayload): Record<string, unknown> => {
    const board = boards[key]!;
    const colValues: Record<string, unknown> = { [board.columns[SF_ID_COLUMN]!]: p.sfId };
    for (const [title, value] of Object.entries(p.columns)) {
      if (value === null || value === undefined || value === '') continue;
      const id = board.columns[title];
      if (!id) throw new Error(`load: board ${key} has no column id for "${title}"`);
      const formatted = formatColumnValue(COLUMN_TYPES[title] ?? 'text', value);
      if (formatted === null) continue;
      colValues[id] = formatted;
    }
    return colValues;
  };

  // The pre-#22 path, unchanged: one create_item per request, one payload at a time. Kept as
  // the cutover-weekend fallback (`load --sequential`).
  const createItemsSequential = async (key: string, items: ItemPayload[]): Promise<void> => {
    const board = boards[key]!;
    const sfIdColId = board.columns[SF_ID_COLUMN]!;
    for (const p of items) {
      if (ledger.has(p.sfId, key)) continue;
      const colValues = buildColValues(key, p);
      try {
        let itemId: string | undefined;
        for (let attempt = 1; itemId === undefined; attempt++) {
          try {
            const res = await client.gql<{ create_item: { id: string } }>(
              `mutation ($boardId: ID!, $itemName: String!, $cols: JSON, $create: Boolean!) {
                 create_item (board_id: $boardId, item_name: $itemName, column_values: $cols,
                   create_labels_if_missing: $create) { id } }`,
              { boardId: String(board.boardId), itemName: p.name, cols: JSON.stringify(colValues), create: true },
              { idempotent: false });
            itemId = res.create_item.id;
            bump(report.created, key);
          } catch (err) {
            if (!(err instanceof AmbiguousWriteError) || attempt >= CREATE_ATTEMPTS) throw err;
            // The create may have committed — look before re-creating.
            const found = await findItemIdsBySfId(client, board.boardId, sfIdColId, p.sfId);
            if (found.length > 0) {
              itemId = found[0]!;
              bump(report.adopted, key);
              if (found.length > 1) report.duplicates.push({ board: key, sfId: p.sfId, itemIds: found });
            }
          }
        }
        await ledger.recordSuccess({ sfId: p.sfId, board: key, itemId });
      } catch (err) {
        bump(report.createFailed, key);
        await ledger.recordFailure({ sfId: p.sfId, board: key, error: String(err) });
        console.error(`load: FAILED ${key}/${p.sfId}: ${String(err)}`);
      }
    }
  };

  // sfIds whose links were (re)written during THIS run — an item that had a link retried
  // after a prior run archived it must be re-archived below, ledger notwithstanding.
  const linkedThisRun = new Set<string>();

  // Ledger one batched-create outcome (load/batch.ts decides it; this only records it). A ledger
  // write that throws propagates and stops the run — the next run's board scan adopts whatever
  // Monday holds that the ledger missed.
  const recordOutcome = async (key: string, o: CreateOutcome, inline: InlineLink[]): Promise<void> => {
    if (o.kind === 'failed') {
      bump(report.createFailed, key);
      await ledger.recordFailure({ sfId: o.sfId, board: key, error: o.error });
      console.error(`load: FAILED ${key}/${o.sfId}: ${o.error}`);
      return;
    }
    bump(o.kind === 'created' ? report.created : report.adopted, key);
    if (o.kind === 'adopted' && o.itemIds.length > 1) {
      report.duplicates.push({ board: key, sfId: o.sfId, itemIds: o.itemIds });
    }
    await ledger.recordSuccess({ sfId: o.sfId, board: key, itemId: o.itemId });
    // Inline relations count as written only when THIS create returned them. An adopted item
    // may be from an earlier attempt or run, so its links are left to the link pass, as is any
    // relation Monday didn't echo back.
    if (o.kind !== 'created') return;
    if (o.relationsDropped) {
      // Monday rejected the create while it carried these relations; it was created without
      // them, so every one goes to the link pass (and the #21 gate if that fails too).
      report.links.inlineRejected += inline.length;
      console.warn(`load: ${key}/${o.sfId} rejected with inline relations, created without them — ` +
        `the link pass will write ${inline.map((l) => `"${l.column}"`).join(', ')}`);
      return;
    }
    for (const l of inline) {
      const linked = new Set(o.linked?.[l.colId] ?? []);
      if (!l.targetItemIds.every((id) => linked.has(String(id)))) {
        report.links.inlineUnconfirmed++;
        console.warn(`load: ${key}/${o.sfId} "${l.column}" not confirmed by create_item — ` +
          `the link pass will write it`);
        continue;
      }
      await ledger.recordLink(o.sfId, l.column, l.targetSfIds);
      report.links.inline++;
      linkedThisRun.add(o.sfId);
      for (const t of l.targetSfIds) linkedThisRun.add(t);
    }
  };

  // Shared by every create worker: pauses new batches when the complexity budget runs low.
  const gate = new ComplexityGate((ms) => client.sleep(ms), Date.now, opts.concurrency);

  // #22: opts.batchSize aliased create_items per request, opts.concurrency requests in flight.
  const createItemsBatched = async (key: string, items: ItemPayload[]): Promise<void> => {
    const board = boards[key]!;
    const entries: CreateEntry[] = [];
    const inlineBySfId = new Map<string, InlineLink[]>();
    const inlineCtx: InlineContext = {
      itemIdOf: (sfId) => ledger.itemId(sfId), isExpected: (sfId) => expectedSfIds.has(sfId),
      isArchived: (sfId) => ledger.archivedDone(sfId), columnId: (title) => board.columns[title],
    };
    for (const p of items) {
      // A Salesforce Id is created at most once per run, even if a payload repeats it.
      if (ledger.has(p.sfId, key) || inlineBySfId.has(p.sfId)) continue;
      const colValues = buildColValues(key, p);
      // Targets are only ever ledgered by an earlier board or fiscal year, never by a create
      // running concurrently with this one, so planning up front is exact.
      const inline = opts.inlineLinks ? planInlineLinks(p, inlineCtx) : [];
      const plainColValues = { ...colValues };
      for (const l of inline) colValues[l.colId] = { item_ids: l.targetItemIds };
      inlineBySfId.set(p.sfId, inline);
      entries.push({ sfId: p.sfId, name: p.name, colValues,
        ...(inline.length ? { readBack: inline.map((l) => l.colId), plainColValues } : {}) });
    }
    const batches: CreateEntry[][] = [];
    for (let i = 0; i < entries.length; i += opts.batchSize) batches.push(entries.slice(i, i + opts.batchSize));
    await runPool(batches, opts.concurrency, (batch) => createBatch({
      client, boardId: board.boardId, sfIdColId: board.columns[SF_ID_COLUMN]!, entries: batch,
      attempts: CREATE_ATTEMPTS, lookupDelayMs: opts.recoveryLookupDelayMs, gate,
      onOutcome: (o) => recordOutcome(key, o, inlineBySfId.get(o.sfId) ?? []),
    }));
    if (entries.length > 0) {
      await scanForDuplicates(key, key === 'donations' ? `donations FY${payloadFY(items[0]!) || '(undated)'}` : key);
    }
  };

  // After a board (or a donations fiscal year) is written in batched mode, read it back by
  // Salesforce ID and report any Id Monday holds more than once — the backstop for a batch
  // Monday committed after the client gave up. Runs before archiving, while items_page can
  // still see them. Never deletes anything. A read-back that fails is recorded and fails the
  // run (the duplicate check didn't happen) but doesn't stop the link and archive phases.
  const scanForDuplicates = async (key: string, where: string): Promise<void> => {
    const board = boards[key]!;
    let scan: Awaited<ReturnType<typeof scanBoardSfIds>>;
    try {
      scan = await scanBoardSfIds(client, board.boardId, board.columns[SF_ID_COLUMN]!);
    } catch (err) {
      report.readBackFailed.push({ where, error: String(err) });
      console.error(`load: READ-BACK FAILED for ${where} — duplicates on it were NOT checked ` +
        `(${String(err)}); re-run load or validate --live before trusting this board`);
      return;
    }
    for (const [sfId, itemIds] of scan.bySfId) {
      if (itemIds.length < 2 || report.duplicates.some((d) => d.board === key && d.sfId === sfId)) continue;
      report.duplicates.push({ board: key, sfId, itemIds });
      console.log(`load: DUPLICATE ${key}/${sfId} exists ${itemIds.length}× on Monday (items ${itemIds.join(', ')}) ` +
        `— remove the extras by hand; see data/load/report.json`);
    }
  };

  const createItems = isLegacySequential(opts) ? createItemsSequential : createItemsBatched;

  // Link machinery: a small worker pool runs LINK_CONCURRENCY mutations in flight; each link
  // still ledgers individually and per-call retry/backoff lives in the client.
  // sfIds that must not be archived this run because a link from or into them is still waiting
  // on a target (or source) item that is expected but doesn't exist yet.
  const pendingArchiveBlock = new Set<string>();
  const buildLinkTasks = (entries: DeferredLink[]): LinkTask[] => {
    const tasks: LinkTask[] = [];
    for (const { key, payload: p, link } of entries) {
      const board = boards[key]!;
      const itemId = ledger.itemId(p.sfId);
      if (!itemId) {
        // The source's own create failed: its link into these targets can't be written yet, so
        // they mustn't archive (an event-registration's Payment pointing into a donation).
        for (const t of link.targetSfIds) pendingArchiveBlock.add(t);
        continue;
      }
      const resolved = link.targetSfIds
        .map((sfId) => ({ sfId, targetItemId: ledger.itemId(sfId) }))
        .filter((t): t is { sfId: string; targetItemId: string } => t.targetItemId !== undefined);
      const pendingTargets = link.targetSfIds.filter((t) => !ledger.itemId(t) && expectedSfIds.has(t));
      if (pendingTargets.length > 0) {
        report.links.pending++;
        pendingArchiveBlock.add(p.sfId);
      }
      if (resolved.length === 0) {
        if (pendingTargets.length === 0) report.links.skippedByDesign++;
        continue;
      }
      if (resolved.length < link.targetSfIds.length) report.links.partial++;
      // A link written earlier with fewer targets is rewritten once more of them resolve.
      if (ledger.linkCovers(p.sfId, link.column, resolved.map((t) => t.sfId))) continue;
      const colId = board.columns[link.column];
      if (!colId) throw new Error(`load: board ${key} missing connect column "${link.column}"`);
      tasks.push({ boardId: board.boardId, itemId, colId,
        targetIds: resolved.map((t) => Number(t.targetItemId)),
        targetSfIds: resolved.map((t) => t.sfId), sfId: p.sfId, column: link.column });
    }
    return tasks;
  };
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
          await ledger.recordLink(t.sfId, t.column, t.targetSfIds);
          report.links.written++;
          linkedThisRun.add(t.sfId);
          // Targets count too: a retried incoming link means its target was unarchived for
          // the write to stick, so the re-archive check below must see it as touched.
          for (const target of t.targetSfIds) linkedThisRun.add(target);
        } catch (err) {
          report.links.failed++;
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
      // source, same as before. pendingArchiveBlock adds links that couldn't even be attempted
      // because an expected item (e.g. the Donor, whose create failed) doesn't exist yet.
      const pendingLinkSfIds = new Set(
        ledger.failures().filter((f) => f.board.startsWith('link:'))
          .flatMap((f) => [f.sfId, ...(f.targetSfIds ?? [])]));
      const toArchive = group.filter((p) => p.archive);
      let archivedCount = 0, deferredCount = 0;
      // Decide every item first (the #21 gate reads only state settled above), then archive the
      // cleared ones opts.concurrency at a time — archive_item is idempotent and was the largest
      // remaining sequential cost after #22's create/link changes. --sequential keeps it 1.
      const cleared: { p: ItemPayload; itemId: string }[] = [];
      for (const p of toArchive) {
        // Re-archive when a link was rewritten this run (the user unarchived it for the retry).
        if (ledger.archivedDone(p.sfId) && !linkedThisRun.has(p.sfId)) { archivedCount++; continue; }
        const itemId = ledger.itemId(p.sfId);
        if (!itemId) continue; // creation failed above; already ledgered as a failure
        if (pendingLinkSfIds.has(p.sfId) || pendingArchiveBlock.has(p.sfId)) {
          deferredCount++;
          report.archive.deferred++;
          console.warn(`load: NOT archiving donations/${p.sfId} — links still unresolved; ` +
            `fix links (re-run load), then it archives on the next run`);
          continue;
        }
        cleared.push({ p, itemId });
      }
      await runPool(cleared, opts.concurrency, async ({ p, itemId }) => {
        try {
          await client.gql(`mutation ($id: ID!) { archive_item (item_id: $id) { id } }`, { id: itemId });
          await ledger.recordArchive(p.sfId);
          archivedCount++;
          report.archive.archived++;
        } catch (err) {
          report.archive.failed++;
          await ledger.recordArchiveFailure(p.sfId, String(err));
        }
      });
      console.log(`load: donations FY${fy || '(undated)'} — ${group.length} items, ` +
        `${archivedCount} archived` + (deferredCount > 0 ? `, ${deferredCount} archive-deferred` : ''));
    }
    console.log('load: donations phase-3 complete');
  }
  // Deferred links whose target donations weren't in this run's payload set (e.g. created by
  // a previous run) — attempt normally; unresolvable targets count as skipped as usual.
  const deferredLeftover = [...deferredByFY.values()].flat();
  if (deferredLeftover.length > 0) await runLinkTasks(buildLinkTasks(deferredLeftover));

  const l = report.links;
  if (l.skippedByDesign > 0) console.warn(`load: ${l.skippedByDesign} links skipped (targets not migrated)`);
  if (l.partial > 0) console.warn(`load: ${l.partial} links wrote a partial set of targets`);
  if (l.pending > 0) console.warn(`load: ${l.pending} links waiting on target items that failed or ` +
    `haven't been created — re-run "load" after fixing the failures`);
  if (report.duplicates.length > 0) {
    console.error(`load: ${report.duplicates.length} Salesforce Ids exist more than once on Monday — ` +
      `see data/load/report.json and remove the extras by hand`);
  }
  await writeJson(dataPath('load', 'report.json'), { ...report, finishedAt: new Date().toISOString() });

  const failures = ledger.failures();
  if (report.readBackFailed.length > 0) {
    console.error(`load: ${report.readBackFailed.length} duplicate read-back(s) failed: ` +
      `${report.readBackFailed.map((r) => r.where).join(', ')} — see data/load/report.json`);
  }
  if (failures.length > 0 || l.pending > 0 || report.duplicates.length > 0 || report.readBackFailed.length > 0) {
    if (failures.length > 0) {
      console.error(`load: ${failures.length} unresolved failures — re-run "load" to retry just these`);
      for (const f of failures.slice(0, 20)) console.error(`  ${f.board}/${f.sfId}: ${f.error}`);
    }
    return 1;
  }
  console.log('load: complete, no unresolved failures');
  return 0;
}

registerCommand('load', (args) => runLoad(args));
