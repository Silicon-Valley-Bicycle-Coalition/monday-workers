import { READABLE_SNAPSHOT_FORMATS } from '../format';
import type { BoardSchema, BoardSummary, DocBlock, DocSummary, ItemRecord, UpdateRecord } from '../types';

// Reads a snapshot folder (as downloaded from Drive) back into memory. Restore runs on an
// operator's machine, not in the Worker, so holding one snapshot in memory is fine there.

export interface BoardSnapshot {
  board: BoardSummary;
  schema: BoardSchema;
  items: ItemRecord[];
  updates: UpdateRecord[];
}

export interface DocSnapshot {
  doc: DocSummary;
  blocks: DocBlock[];
}

export interface SnapshotManifest {
  format: string;
  runId?: number;
  runAt?: string;
  // A snapshot is captured over a window (runAt to finishedAt), one board or doc at a time.
  finishedAt?: string;
  capturedAt?: Record<string, { startedAt: string; finishedAt: string }>;
  errors?: string[];
  itemCountsByBoard?: Record<string, number>;
  updateCountsByBoard?: Record<string, number>;
  blockCountsByDoc?: Record<string, number>;
  [key: string]: unknown;
}

export interface Snapshot {
  manifest: SnapshotManifest;
  boards: BoardSnapshot[];
  docs: DocSnapshot[];
  // Problems found while reading — e.g. a board whose record count disagrees with the manifest.
  warnings: string[];
}

type JsonlRecord = { type: string } & Record<string, unknown>;

function* records(filename: string, text: string): Generator<JsonlRecord> {
  let lineNo = 0;
  for (const raw of text.split('\n')) {
    lineNo++;
    if (raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${filename}:${lineNo}: not valid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as JsonlRecord).type !== 'string') {
      throw new Error(`${filename}:${lineNo}: record has no type`);
    }
    yield parsed as JsonlRecord;
  }
}

function parseBoard(filename: string, text: string): BoardSnapshot {
  let snapshot: BoardSnapshot | null = null;
  for (const record of records(filename, text)) {
    if (record.type === 'board') {
      snapshot = { board: record.board as BoardSummary, schema: record.schema as BoardSchema, items: [], updates: [] };
    } else if (snapshot === null) {
      throw new Error(`${filename}: first record must be the board header`);
    } else if (record.type === 'item') {
      snapshot.items.push(record.item as ItemRecord);
    } else if (record.type === 'update') {
      snapshot.updates.push(record.update as UpdateRecord);
    } else {
      throw new Error(`${filename}: unknown record type "${record.type}"`);
    }
  }
  if (snapshot === null) throw new Error(`${filename}: empty file`);
  return snapshot;
}

function parseDoc(filename: string, text: string): DocSnapshot {
  let snapshot: DocSnapshot | null = null;
  for (const record of records(filename, text)) {
    if (record.type === 'doc') {
      snapshot = { doc: record.doc as DocSummary, blocks: [] };
    } else if (snapshot === null) {
      throw new Error(`${filename}: first record must be the doc header`);
    } else if (record.type === 'block') {
      snapshot.blocks.push(record.block as DocBlock);
    } else {
      throw new Error(`${filename}: unknown record type "${record.type}"`);
    }
  }
  if (snapshot === null) throw new Error(`${filename}: empty file`);
  return snapshot;
}

// `files` maps each filename in the snapshot folder to its text.
export function parseSnapshot(files: Map<string, string>): Snapshot {
  const manifestText = files.get('manifest.json');
  if (manifestText === undefined) {
    throw new Error('snapshot has no manifest.json — the run did not finish; pick another snapshot');
  }
  const manifest = JSON.parse(manifestText) as SnapshotManifest;
  // v2 and v3 hold the same records; v3's files arrive here already decrypted (./files.ts).
  if (!READABLE_SNAPSHOT_FORMATS.includes(manifest.format)) {
    throw new Error(
      `snapshot format "${String(manifest.format)}" is not one of ${READABLE_SNAPSHOT_FORMATS.join(', ')}; this restore tool cannot read it`,
    );
  }

  const warnings: string[] = [];
  for (const error of manifest.errors ?? []) warnings.push(`snapshot was partial: ${error}`);

  const boards: BoardSnapshot[] = [];
  const docs: DocSnapshot[] = [];
  for (const [filename, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (/^board-.+\.jsonl$/.test(filename)) {
      const board = parseBoard(filename, text);
      const expected = manifest.itemCountsByBoard?.[board.board.id];
      if (expected !== undefined && expected !== board.items.length) {
        warnings.push(`${filename}: manifest says ${expected} items, file has ${board.items.length}`);
      }
      boards.push(board);
    } else if (/^doc-.+\.jsonl$/.test(filename)) {
      const doc = parseDoc(filename, text);
      const expected = manifest.blockCountsByDoc?.[doc.doc.id];
      if (expected !== undefined && expected !== doc.blocks.length) {
        warnings.push(`${filename}: manifest says ${expected} blocks, file has ${doc.blocks.length}`);
      }
      docs.push(doc);
    }
  }
  return { manifest, boards, docs, warnings };
}
