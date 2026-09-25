import { AmbiguousWriteError } from '../monday/graphql';
import type { BoardSchema, ColumnDef, ItemRecord, UpdateRecord } from '../types';
import { errorMessage } from '../util/errorMessage';
import type { RestoreApi } from './api';
import { RELATION_TYPES, relationValue, writableValue } from './columnValues';
import type { RestoreLedger } from './ledger';
import type { BoardSnapshot, Snapshot } from './snapshot';

// Rebuilds boards, items, subitems, relations, updates and Docs from a snapshot into a target
// workspace. Every created object is recorded in the ledger first-thing, so a rerun after an
// interruption skips what already exists. See RESTORE.md for the operator procedure.

export interface RestoreOptions {
  api: RestoreApi;
  ledger: RestoreLedger;
  targetWorkspaceId: string;
  // Appended to every restored board and doc name, so restored copies are never mistaken for
  // the originals (e.g. " (restored 2026-09-25)").
  nameSuffix: string;
  // Restrict to these snapshot board ids (their subitems boards come along). Absent = all.
  boardIds?: string[];
  // Restrict to these doc ids. Absent = all; empty = none.
  docIds?: string[];
  log?: (message: string) => void;
}

export interface RestoreReport {
  boards: number;
  columns: number;
  items: number;
  subitems: number;
  relations: number;
  updates: number;
  docs: number;
  blocks: number;
  warnings: string[];
}

// Monday accepts a custom column id only if it is 1–20 lowercase letters/underscores, so ids
// like `text_mkq1abcd` get a fresh one and values are remapped by the ledger.
const REUSABLE_COLUMN_ID = /^[a-z_]{1,20}$/;
// Column types a new board or subitems board brings on its own — never created again.
const BUILT_IN_COLUMNS = new Set(['name', 'subtasks']);

function settingsOf(column: ColumnDef): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(column.settingsStr) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function blockContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? {});
}

function provenance(update: { creatorId: string | null; createdAt: string | null }): string {
  const who = update.creatorId === null ? 'an unknown user' : `user ${update.creatorId}`;
  const when = update.createdAt ?? 'an unknown time';
  return `<p><em>Restored from backup — originally posted by ${who} at ${when}.</em></p>`;
}

export async function restoreSnapshot(snapshot: Snapshot, options: RestoreOptions): Promise<RestoreReport> {
  const { api, ledger, targetWorkspaceId, nameSuffix } = options;
  const log = options.log ?? (() => {});
  const report: RestoreReport = { boards: 0, columns: 0, items: 0, subitems: 0, relations: 0, updates: 0, docs: 0, blocks: 0, warnings: [] };
  const warn = (message: string): void => {
    report.warnings.push(message);
    log(`warning: ${message}`);
  };
  report.warnings.push(...snapshot.warnings);

  // Any write that fails ambiguously stops the whole restore: the ledger lets a rerun resume,
  // but the operator must first check whether that one object was created (RESTORE.md).
  const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AmbiguousWriteError) throw err;
      warn(`${what}: ${errorMessage(err)}`);
      return undefined;
    }
  };

  // ── Which boards ────────────────────────────────────────────────────────────────────────────
  const byId = new Map(snapshot.boards.map((b) => [b.board.id, b]));
  const parentOf = new Map<string, string>(); // subitems board → parent board
  for (const b of snapshot.boards) {
    if (b.board.parentBoardId !== undefined) parentOf.set(b.board.id, b.board.parentBoardId);
    for (const column of b.schema.columns) {
      if (column.type !== 'subtasks') continue;
      const ids = (settingsOf(column)?.boardIds ?? []) as (string | number)[];
      for (const id of ids) parentOf.set(String(id), b.board.id);
    }
  }
  const isSubitemBoard = (b: BoardSnapshot): boolean => b.board.type === 'sub_items_board' || parentOf.has(b.board.id);
  const selected = (id: string): boolean => options.boardIds === undefined || options.boardIds.includes(id);

  const mainBoards: BoardSnapshot[] = [];
  for (const b of snapshot.boards) {
    if (isSubitemBoard(b)) continue;
    // A `document`-type board is the container behind a Doc; the Doc is restored from its own file.
    if (b.board.type === 'document') continue;
    if (b.board.state === 'deleted') continue;
    if (selected(b.board.id)) mainBoards.push(b);
  }
  const mainIds = new Set(mainBoards.map((b) => b.board.id));
  const subitemBoards = snapshot.boards.filter((b) => isSubitemBoard(b) && mainIds.has(parentOf.get(b.board.id) ?? ''));
  for (const b of snapshot.boards) {
    if (isSubitemBoard(b) && !byId.has(parentOf.get(b.board.id) ?? '')) {
      warn(`subitems board ${b.board.id} (${b.board.name}): its parent board is not in the snapshot; skipped`);
    }
  }

  const mapItem = (oldId: string): string | undefined => ledger.get('item', oldId);
  const columnKey = (boardId: string, columnId: string): string => `${boardId}:${columnId}`;

  // Creates one snapshot column on a restored board. Tries to keep the original id and settings;
  // if Monday rejects either, falls back to a plain column of the same type, then gives up with a
  // warning (values for that column are then skipped).
  const restoreColumn = async (oldBoardId: string, newBoardId: string, column: ColumnDef, defaults?: unknown): Promise<void> => {
    const key = columnKey(oldBoardId, column.id);
    if (ledger.get('column', key) !== undefined) return;
    const base = { boardId: newBoardId, title: column.title, type: column.type, description: column.description ?? null };
    const id = REUSABLE_COLUMN_ID.test(column.id) ? column.id : undefined;
    let newId: string | undefined;
    try {
      newId = await api.createColumn({ ...base, defaults, id });
    } catch (err) {
      if (err instanceof AmbiguousWriteError) throw err;
      const firstError = errorMessage(err);
      newId = await attempt(`board ${oldBoardId} column "${column.title}" (${column.type})`, () => api.createColumn(base));
      if (newId === undefined) {
        warn(`board ${oldBoardId} column "${column.title}" (${column.type}) could not be created; its values are not restored`);
      } else {
        warn(`board ${oldBoardId} column "${column.title}" (${column.type}) created without its original id/settings (${firstError}) — check labels and settings`);
      }
    }
    if (newId === undefined) return;
    ledger.set('column', key, newId);
    report.columns++;
    if (column.type === 'mirror' || column.type === 'formula') {
      warn(`board ${oldBoardId} column "${column.title}" (${column.type}) is computed from other columns — check its settings after restore`);
    }
  };

  // Settings worth sending as create_column defaults: labels for status/dropdown, the formula
  // text, and (remapped) linked board ids for relations. Everything else starts plain.
  const defaultsFor = (column: ColumnDef): unknown => {
    const settings = settingsOf(column);
    if (settings === undefined) return undefined;
    if (column.type === 'status' || column.type === 'dropdown' || column.type === 'formula') return settings;
    if (RELATION_TYPES.has(column.type)) {
      const boardIds = ((settings.boardIds ?? []) as (string | number)[])
        .map((id) => ledger.get('board', String(id)))
        .filter((id): id is string => id !== undefined)
        .map(Number);
      return boardIds.length > 0 ? { boardIds } : undefined;
    }
    return undefined;
  };

  const newColumnValues = (oldBoardId: string, schema: BoardSchema, item: ItemRecord): Record<string, unknown> => {
    const columns = new Map(schema.columns.map((c) => [c.id, c]));
    const out: Record<string, unknown> = {};
    for (const cv of item.columnValues) {
      const column = columns.get(cv.id);
      if (column === undefined) continue;
      const newColumnId = ledger.get('column', columnKey(oldBoardId, cv.id));
      if (newColumnId === undefined) continue;
      const value = writableValue(column, cv);
      if (value !== undefined) out[newColumnId] = value;
    }
    return out;
  };

  // Writes values column by column after a whole-item write was rejected, so one bad value costs
  // that value, not the item's others.
  const setValuesOneByOne = async (boardId: string, itemId: string, oldItemId: string, values: Record<string, unknown>): Promise<void> => {
    for (const [columnId, value] of Object.entries(values)) {
      await attempt(`item ${oldItemId} column ${columnId}`, () => api.setColumnValues({ boardId, itemId, columnValues: { [columnId]: value } }));
    }
  };

  // ── 1. Boards, groups, non-relation columns, items ──────────────────────────────────────────
  for (const b of mainBoards) {
    const { board, schema } = b;
    let newBoardId = ledger.get('board', board.id);
    if (newBoardId === undefined) {
      newBoardId = await api.createBoard({
        name: `${board.name}${nameSuffix}`,
        kind: board.boardKind ?? 'public',
        workspaceId: targetWorkspaceId,
        description: board.description ?? null,
      });
      ledger.set('board', board.id, newBoardId);
      report.boards++;
      log(`board ${board.id} "${board.name}" → ${newBoardId}`);
    }

    // create_group adds at the top, so creating in reverse leaves the snapshot's order.
    for (const group of [...schema.groups].reverse()) {
      const key = columnKey(board.id, group.id);
      if (ledger.get('group', key) !== undefined) continue;
      const newGroupId = await attempt(`board ${board.id} group "${group.title}"`, () =>
        api.createGroup({ boardId: newBoardId, name: group.title, color: group.color ?? null }),
      );
      if (newGroupId !== undefined) ledger.set('group', key, newGroupId);
    }

    for (const column of schema.columns) {
      if (BUILT_IN_COLUMNS.has(column.type) || RELATION_TYPES.has(column.type)) continue;
      await restoreColumn(board.id, newBoardId, column, defaultsFor(column));
    }

    for (const item of b.items) {
      if (item.parentItemId) continue; // subitems are restored under their parent below
      if (mapItem(item.id) !== undefined) continue;
      const values = newColumnValues(board.id, schema, item);
      const groupId = item.groupId === null ? undefined : ledger.get('group', columnKey(board.id, item.groupId));
      let newItemId: string;
      try {
        newItemId = await api.createItem({ boardId: newBoardId, groupId, name: item.name, columnValues: values });
      } catch (err) {
        if (err instanceof AmbiguousWriteError) throw err;
        // Most likely one value Monday won't accept: keep the item, then set values one by one.
        warn(`item ${item.id} "${item.name}": values rejected (${errorMessage(err)}); retrying value by value`);
        const bare = await attempt(`item ${item.id} "${item.name}"`, () =>
          api.createItem({ boardId: newBoardId, groupId, name: item.name, columnValues: {} }),
        );
        if (bare === undefined) continue;
        ledger.set('item', item.id, bare);
        report.items++;
        await setValuesOneByOne(newBoardId, bare, item.id, values);
        continue;
      }
      ledger.set('item', item.id, newItemId);
      report.items++;
    }
  }

  // ── 2. Relation columns, now that every board they can point at exists ────────────────────
  for (const b of mainBoards) {
    const newBoardId = ledger.get('board', b.board.id)!;
    for (const column of b.schema.columns) {
      if (RELATION_TYPES.has(column.type)) await restoreColumn(b.board.id, newBoardId, column, defaultsFor(column));
    }
  }

  // ── 3. Subitems ────────────────────────────────────────────────────────────────────────────
  for (const b of subitemBoards) {
    const { board, schema } = b;
    const created: { oldId: string; newId: string; item: ItemRecord }[] = [];
    for (const item of b.items) {
      const existing = mapItem(item.id);
      if (existing !== undefined) {
        created.push({ oldId: item.id, newId: existing, item });
        continue;
      }
      const parent = item.parentItemId ? mapItem(item.parentItemId) : undefined;
      if (parent === undefined) {
        warn(`subitem ${item.id} "${item.name}": parent item ${item.parentItemId ?? '(none)'} was not restored; skipped`);
        continue;
      }
      const result = await api.createSubitem({ parentItemId: parent, name: item.name });
      if (ledger.get('board', board.id) === undefined) ledger.set('board', board.id, result.boardId);
      ledger.set('item', item.id, result.id);
      report.subitems++;
      created.push({ oldId: item.id, newId: result.id, item });
    }
    const newBoardId = ledger.get('board', board.id);
    if (newBoardId === undefined) continue; // no subitem could be created

    // Monday auto-creates the subitems board with its own default columns; add the snapshot's.
    const autoCreated = await api.listColumns(newBoardId);
    for (const column of schema.columns) {
      if (BUILT_IN_COLUMNS.has(column.type)) continue;
      const key = columnKey(board.id, column.id);
      // Same type and title as an auto-created default column: reuse it rather than duplicating.
      const match = autoCreated.find((c) => c.type === column.type && c.title === column.title);
      if (match !== undefined && ledger.get('column', key) === undefined) {
        ledger.set('column', key, match.id);
        continue;
      }
      await restoreColumn(board.id, newBoardId, column, defaultsFor(column));
    }
    for (const { oldId, newId, item } of created) {
      if (ledger.get('done', `values:${oldId}`) !== undefined) continue;
      const values = newColumnValues(board.id, schema, item);
      if (Object.keys(values).length > 0) {
        const ok = await attempt(`subitem ${oldId} values`, () => api.setColumnValues({ boardId: newBoardId, itemId: newId, columnValues: values }));
        if (ok === undefined) await setValuesOneByOne(newBoardId, newId, oldId, values);
      }
      ledger.set('done', `values:${oldId}`, '1');
    }
  }

  // ── 4. Relation values (connect boards, dependencies), mapped to restored item ids ─────────
  for (const b of [...mainBoards, ...subitemBoards]) {
    const newBoardId = ledger.get('board', b.board.id);
    if (newBoardId === undefined) continue;
    const columns = new Map(b.schema.columns.map((c) => [c.id, c]));
    for (const item of b.items) {
      const newItemId = mapItem(item.id);
      if (newItemId === undefined || ledger.get('done', `relations:${item.id}`) !== undefined) continue;
      const values: Record<string, unknown> = {};
      for (const cv of item.columnValues) {
        const column = columns.get(cv.id);
        if (column === undefined || !RELATION_TYPES.has(column.type)) continue;
        const newColumnId = ledger.get('column', columnKey(b.board.id, cv.id));
        const mapped = relationValue(cv, mapItem);
        if (newColumnId === undefined || mapped === undefined) continue;
        if (mapped.dropped.length > 0) {
          warn(`item ${item.id} column "${column.title}": links to ${mapped.dropped.join(', ')} dropped (not in this restore)`);
        }
        if (mapped.value !== undefined) values[newColumnId] = mapped.value;
      }
      if (Object.keys(values).length > 0) {
        await attempt(`item ${item.id} relations`, () => api.setColumnValues({ boardId: newBoardId, itemId: newItemId, columnValues: values }));
        report.relations++;
      }
      ledger.set('done', `relations:${item.id}`, '1');
    }
  }

  // ── 5. Updates and replies, oldest first, each marked with its original author and time ────
  for (const b of [...mainBoards, ...subitemBoards]) {
    const updates = [...b.updates].sort((x: UpdateRecord, y: UpdateRecord) => (x.createdAt ?? '').localeCompare(y.createdAt ?? ''));
    const boardLevel = updates.filter((u) => u.itemId === null).length;
    if (boardLevel > 0) warn(`board ${b.board.id}: ${boardLevel} board-level update(s) not restored (the API only posts updates on items)`);
    for (const update of updates) {
      if (update.itemId === null) continue;
      const newItemId = mapItem(update.itemId);
      if (newItemId === undefined) {
        warn(`update ${update.id}: item ${update.itemId} was not restored; skipped`);
        continue;
      }
      let newUpdateId = ledger.get('update', update.id);
      if (newUpdateId === undefined) {
        newUpdateId = await attempt(`update ${update.id}`, () => api.createUpdate({ itemId: newItemId, body: provenance(update) + update.body }));
        if (newUpdateId === undefined) continue;
        ledger.set('update', update.id, newUpdateId);
        report.updates++;
      }
      for (const reply of update.replies) {
        if (ledger.get('update', reply.id) !== undefined) continue;
        const parentId = newUpdateId;
        const newReplyId = await attempt(`reply ${reply.id}`, () =>
          api.createUpdate({ itemId: newItemId, parentId, body: provenance(reply) + reply.body }),
        );
        if (newReplyId === undefined) continue;
        ledger.set('update', reply.id, newReplyId);
        report.updates++;
      }
      if (update.assets.length > 0) warn(`update ${update.id}: ${update.assets.length} attached file(s) not restored (metadata is in the snapshot)`);
    }
  }

  // Files on items: metadata only, by design (see README "What this does not cover").
  const itemFiles = [...mainBoards, ...subitemBoards].reduce((n, b) => n + b.items.reduce((m, i) => m + (i.assets?.length ?? 0), 0), 0);
  if (itemFiles > 0) warn(`${itemFiles} item file(s) not restored — their names, sizes and uploaders are in the snapshot`);

  // ── 6. Archive boards that were archived, last, so everything above could still write to them
  for (const b of mainBoards) {
    if (b.board.state !== 'archived' || ledger.get('done', `archived:${b.board.id}`) !== undefined) continue;
    await attempt(`archive board ${b.board.id}`, () => api.archiveBoard(ledger.get('board', b.board.id)!));
    ledger.set('done', `archived:${b.board.id}`, '1');
  }

  // ── 7. Docs and their blocks, in document order, nesting preserved ─────────────────────────
  const docs = snapshot.docs.filter((d) => options.docIds === undefined || options.docIds.includes(d.doc.id));
  for (const { doc, blocks } of docs) {
    let newDocId = ledger.get('doc', doc.id);
    if (newDocId === undefined) {
      newDocId = await api.createDoc({ workspaceId: targetWorkspaceId, name: `${doc.name}${nameSuffix}`, kind: doc.docKind ?? 'public' });
      ledger.set('doc', doc.id, newDocId);
      report.docs++;
      log(`doc ${doc.id} "${doc.name}" → ${newDocId}`);
    }
    const docId = newDocId;
    // create_doc_block appends after `after_block_id`; track the last block under each parent.
    const lastUnder = new Map<string, string>();
    for (const block of blocks) {
      const parentKey = block.parentBlockId ?? '';
      const existing = ledger.get('block', block.id);
      if (existing !== undefined) {
        lastUnder.set(parentKey, existing);
        continue;
      }
      const parentBlockId = block.parentBlockId ? ledger.get('block', block.parentBlockId) : undefined;
      if (block.parentBlockId && parentBlockId === undefined) {
        warn(`doc ${doc.id} block ${block.id}: parent block ${block.parentBlockId} was not restored; skipped`);
        continue;
      }
      const afterBlockId = lastUnder.get(parentKey);
      const newBlockId = await attempt(`doc ${doc.id} block ${block.id} (${block.type})`, () =>
        api.createDocBlock({ docId, type: block.type, content: blockContent(block.content), afterBlockId, parentBlockId }),
      );
      if (newBlockId === undefined) continue;
      ledger.set('block', block.id, newBlockId);
      lastUnder.set(parentKey, newBlockId);
      report.blocks++;
    }
  }

  return report;
}
