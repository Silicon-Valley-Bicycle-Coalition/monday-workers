// The queue consumer: one message per matched contact, written as one results-board row (connected
// to the contact) plus, for a person, the search's label on the contact's Nearby column.
//
// Idempotency is a D1 claim per (board, contact): `result_item_id = ''` marks a write in flight,
// a Monday item id (or 'linked') marks it done. A claim older than CLAIM_STALE_MS belongs to a
// delivery that died mid-write, so the next one takes over after checking the board itself: the
// row may already exist (an ambiguous create), and creating it again would duplicate it.
//
// Messages run one at a time, in order: addNearbyLabel is read-modify-write on a dropdown, so two
// concurrent writes to the same contact would lose a label.
import type { Config } from './config';
import { DEFAULT_PII_KEYS, logSkip, messageDisposition, retryDelaySeconds, type LogLevel, type WriteMode } from './flags';
import type { NearbyMondayClient, ResultColumns } from './monday/client';
import { AmbiguousWriteError, MondayApiError } from './monday/graphql';
import { WORKER } from './routes';
import type { WriteMessage } from './types';

export const CLAIM_STALE_MS = 10 * 60 * 1000;
// How long a delivery that finds a fresh claim waits before looking again.
export const CLAIM_WAIT_SECONDS = 600;
const LINKED = 'linked';

export interface ConsumerDeps {
  monday: NearbyMondayClient;
  db: D1Database;
  config: Config;
  mode: WriteMode;
  logLevel?: LogLevel;
  environment?: string;
  now?: () => Date;
}

// 4xx statuses that are not about the request itself, so they stay retryable: a rejected token or
// missing board access (fixing it heals the backlog) and the answers that recover with a wait.
// Same rule as funraise-sync/src/errors.ts.
const RETRYABLE_4XX = new Set([401, 403, 408, 409, 425, 429]);
// Monday's codes for a request rejected on its content, sent with HTTP 200 and an `errors` array
// (a deleted contact item is InvalidItemIdException). Same list as funraise-sync/src/errors.ts.
const MONDAY_TERMINAL_CODE =
  /^(ColumnValueException|CorrectedValueException|InvalidArgumentException|InvalidBoardIdException|InvalidColumnIdException|InvalidItemIdException|ItemNameTooLongException|RecordInvalidException|ResourceNotFoundException)$/;

export function isTerminal(err: unknown): err is MondayApiError {
  // A write that may have committed is never terminal: the retry's stale-claim check is what keeps
  // it from being created twice.
  if (!(err instanceof MondayApiError) || err instanceof AmbiguousWriteError) return false;
  const status = err.httpStatus;
  if (status !== undefined && status >= 400 && status < 500) return !RETRYABLE_4XX.has(status);
  return MONDAY_TERMINAL_CODE.test(err.code ?? '');
}

const CLAIM_SQL = "INSERT OR IGNORE INTO result_rows (board_id, contact_id, result_item_id, created_at) VALUES (?, ?, '', ?)";
const READ_SQL = 'SELECT result_item_id, created_at FROM result_rows WHERE board_id = ? AND contact_id = ?';
const DONE_SQL = 'UPDATE result_rows SET result_item_id = ? WHERE board_id = ? AND contact_id = ?';
const RELEASE_SQL = "DELETE FROM result_rows WHERE board_id = ? AND contact_id = ? AND result_item_id = ''";

type Claim = 'claimed' | 'done' | 'wait' | 'stale';

export async function handleBatch(batch: MessageBatch<WriteMessage>, deps: ConsumerDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const columns = new Map<number, Promise<ResultColumns>>();
  const sourceBoardIds = deps.config.monday.sources.map((s) => s.boardId);

  // Once per board per batch, before that board's first write. A failure is not memoized, so the
  // next message for the board asks again.
  const columnsFor = (boardId: number): Promise<ResultColumns> => {
    let pending = columns.get(boardId);
    if (!pending) {
      pending = deps.monday.ensureResultColumns(boardId, sourceBoardIds);
      pending.catch(() => columns.delete(boardId));
      columns.set(boardId, pending);
    }
    return pending;
  };

  const claim = async (board: string, contact: string): Promise<Claim> => {
    const inserted = await deps.db.prepare(CLAIM_SQL).bind(board, contact, now().toISOString()).run();
    if (inserted.meta.changes === 1) return 'claimed';
    const row = await deps.db.prepare(READ_SQL).bind(board, contact).first<{ result_item_id: string; created_at: string }>();
    // Released between the insert and the read: look again later rather than write unclaimed.
    if (!row) return 'wait';
    if (row.result_item_id !== '') return 'done';
    const age = now().getTime() - Date.parse(row.created_at);
    return Number.isFinite(age) && age < CLAIM_STALE_MS ? 'wait' : 'stale';
  };

  for (const msg of batch.messages) {
    const body = msg.body;
    const disposition = messageDisposition(deps.mode, body.stamp);
    if (disposition === 'retry') {
      msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
      continue;
    }
    if (disposition === 'dry-run') {
      logSkip(
        {
          worker: WORKER,
          environment: deps.environment ?? 'production',
          mode: deps.mode,
          logLevel: deps.logLevel ?? 'normal',
          deliveryId: msg.id,
          // The search label is free text a staff member typed, often an address.
          piiKeys: [...DEFAULT_PII_KEYS, 'label'],
        },
        'monday',
        'createResultRow',
        body,
      );
      msg.ack();
      continue;
    }

    const board = String(body.boardId);
    let claimed = false;
    try {
      const state = await claim(board, body.contactId);
      if (state === 'done') { msg.ack(); continue; }
      if (state === 'wait') { msg.retry({ delaySeconds: CLAIM_WAIT_SECONDS }); continue; }
      claimed = true;

      const cols = await columnsFor(body.boardId);
      if (state === 'stale') {
        const linked = await deps.monday.linkedContactIds(body.boardId, cols.connectColumnId);
        if (linked.has(body.contactId)) {
          await deps.db.prepare(DONE_SQL).bind(LINKED, board, body.contactId).run();
          msg.ack();
          continue;
        }
      }

      // Organizations get a board row only, never a Nearby label.
      const source = deps.config.monday.sources.find((s) => s.kind === body.kind);
      if (body.kind !== 'organization' && source?.nearbyColumn) {
        await deps.monday.addNearbyLabel(body.contactId, source.boardId, source.nearbyColumn, body.label);
      }
      const itemId = await deps.monday.createResultRow(body.boardId, body.name, cols, body.contactId, body.label);
      await deps.db.prepare(DONE_SQL).bind(itemId, board, body.contactId).run();
      msg.ack();
    } catch (err) {
      if (isTerminal(err)) {
        // Item ids and codes only: never the name, label or address.
        console.warn(JSON.stringify({ worker: WORKER, terminal: true, itemId: body.contactId, code: err.code ?? err.httpStatus ?? null }));
        // Nothing was created (a non-ambiguous rejection), so free the claim for a later search.
        if (claimed) {
          try {
            await deps.db.prepare(RELEASE_SQL).bind(board, body.contactId).run();
          } catch {
            // A leftover pending claim only goes stale; the next delivery checks the board.
          }
        }
        msg.ack();
        continue;
      }
      const hint = err instanceof MondayApiError ? err.retryAfterSeconds : undefined;
      msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts, hint) });
    }
  }
}
