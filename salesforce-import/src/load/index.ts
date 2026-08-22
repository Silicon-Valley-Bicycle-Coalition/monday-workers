import { registerCommand } from '../commands.js';
import { loadConfig } from '../config.js';
import { dataPath, readJson, readNdjson } from '../artifacts.js';
import type { ItemPayload } from '../transform/types.js';
import type { Era } from '../transform/eras.js';
import { MondayClient } from './monday.js';
import { Ledger } from './ledger.js';
import { ensureBoards } from './boards.js';

const ORDER = ['organizations', 'people-live', 'people-historical', 'campaigns',
  'recurring-gifts', 'events', 'event-registrations', 'volunteers', 'activities'];

function boardOrder(keys: string[]): string[] {
  const eras = keys.filter((k) => k.startsWith('donations:')).sort();
  // Splice era boards into their conceptual slot (right after recurring-gifts) in the full
  // master order first, THEN filter down to present keys — computing the insertion index
  // against the already-filtered `rest` breaks when recurring-gifts isn't in this run's
  // payload set (indexOf returns -1, which shoves the eras to the very front).
  const idx = ORDER.indexOf('recurring-gifts');
  const master = [...ORDER.slice(0, idx + 1), ...eras, ...ORDER.slice(idx + 1)];
  return master.filter((k) => keys.includes(k));
}

export async function runLoad(args: string[], deps: { client?: MondayClient } = {}): Promise<number> {
  const cfg = loadConfig();
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

  const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));
  const eras = await readJson<Era[]>(dataPath('transform', 'eras.json'));
  const eraLabels = Object.fromEntries(eras.map((e) => [e.key, e.label]));

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
      console.log(`load[dry-run]: ${key} → ${items.length} items, ${links} links`);
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
  const boards = await ensureBoards(client, cfg, keys, needed, eraLabels);

  // Phase 1: create items.
  for (const key of keys) {
    const board = boards[key]!;
    for (const p of byBoard.get(key)!) {
      if (ledger.has(p.sfId, key)) continue;
      const colValues: Record<string, unknown> = {};
      for (const [title, value] of Object.entries(p.columns)) {
        if (value === null || value === undefined || value === '') continue;
        const id = board.columns[title];
        if (!id) throw new Error(`load: board ${key} has no column id for "${title}"`);
        colValues[id] = value;
      }
      try {
        const res = await client.gql<{ create_item: { id: string } }>(
          `mutation ($boardId: ID!, $itemName: String!, $cols: JSON) {
             create_item (board_id: $boardId, item_name: $itemName, column_values: $cols) { id } }`,
          { boardId: String(board.boardId), itemName: p.name, cols: JSON.stringify(colValues) });
        await ledger.recordSuccess({ sfId: p.sfId, board: key, itemId: res.create_item.id });
      } catch (err) {
        await ledger.recordFailure({ sfId: p.sfId, board: key, error: String(err) });
        console.error(`load: FAILED ${key}/${p.sfId}: ${String(err)}`);
      }
    }
    console.log(`load: ${key} phase-1 complete`);
  }

  // Phase 2: connect-board links.
  let skippedLinks = 0;
  for (const key of keys) {
    const board = boards[key]!;
    for (const p of byBoard.get(key)!) {
      const itemId = ledger.itemId(p.sfId);
      if (!itemId) continue;
      for (const link of p.links ?? []) {
        if (ledger.linkDone(p.sfId, link.column)) continue;
        const targetIds = link.targetSfIds.map((id) => ledger.itemId(id)).filter(Boolean).map(Number);
        if (targetIds.length === 0) { skippedLinks++; continue; }
        const colId = board.columns[link.column];
        if (!colId) throw new Error(`load: board ${key} missing connect column "${link.column}"`);
        try {
          await client.gql(
            `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
               change_multiple_column_values (board_id: $boardId, item_id: $itemId, column_values: $cols) { id } }`,
            { boardId: String(board.boardId), itemId,
              cols: JSON.stringify({ [colId]: { item_ids: targetIds } }) });
          await ledger.recordLink(p.sfId, link.column);
        } catch (err) {
          await ledger.recordFailure({ sfId: p.sfId, board: key, error: `link ${link.column}: ${String(err)}` });
        }
      }
    }
  }
  if (skippedLinks > 0) console.warn(`load: ${skippedLinks} links skipped (target not migrated)`);

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
