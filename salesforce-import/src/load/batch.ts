import { AmbiguousWriteError, isRejectedBeforeRunning, retryInMs, type MondayClient } from './monday.js';
import { findItemIdsBySfIds } from './lookup.js';

/**
 * Batched, duplicate-safe item creation (#22 on top of #19's guarantees).
 *
 * One request carries up to 25 aliased `create_item`s (or just one). Each entry ends in exactly
 * one outcome, and the rules are the same for every request size:
 *
 * - alias returned an id                        → created
 * - an error BELOW the alias (path deeper than  → committed, id unknown: looked up; adopted if
 *   [alias], e.g. its column_values read-back),   present, else failed and never re-sent
 *   even alongside an [alias] error
 * - an error ON the alias itself (path =        → definite rejection: looked up; adopted if
 *   [alias]) in a response carrying data          present, else failed and never re-sent (parity
 *                                                 with the sequential path) — except an entry
 *                                                 carrying inline relations gets ONE re-send, alone,
 *                                                 without them (the link pass then owns them)
 * - anything else: 5xx, timeout, network error, → looked up; adopted if present, else failed and
 *   cut-off body, no data, whole-request error,   NOT re-sent this run: Monday may still commit
 *   null alias                                    after the client gave up and search can lag, so
 *                                                 a miss proves nothing. The next run's start-of-run
 *                                                 board scan adopts it or creates it.
 * - the recovery lookup itself fails            → failed, NOT re-sent (same next-run recovery)
 *
 * So the only re-send ever made is the relation-less retry of a certain rejection. `load
 * --sequential` doesn't use this module; it keeps the pre-#22 lookup-then-retry rule.
 */

export interface CreateEntry {
  sfId: string;
  name: string;
  /** Monday column id → value, already formatted (Salesforce ID column included). */
  colValues: Record<string, unknown>;
  /** Board-relation column ids to read back on the create response, to confirm inline links. */
  readBack?: string[];
  /** colValues without the inline relations — sent once if Monday rejects the full create. */
  plainColValues?: Record<string, unknown>;
}

export type CreateOutcome =
  // relationsDropped: created by the retry WITHOUT inline relations; the link pass writes them.
  | { sfId: string; kind: 'created'; itemId: string; linked?: Record<string, string[]>; relationsDropped?: boolean }
  // itemIds: everything the lookup found; more than one means Monday holds duplicates.
  | { sfId: string; kind: 'adopted'; itemId: string; itemIds: string[] }
  | { sfId: string; kind: 'failed'; error: string };

interface Complexity { query?: number; after?: number; reset_in_x_seconds?: number }

/** Monday caps a request's size well above this; 25 keeps one request's complexity modest. */
export const MAX_BATCH_SIZE = 25;

/**
 * The aliased mutation for one batch. `readBack[i]` lists the relation columns alias i should
 * return; aliases with none select only `id` (an empty `ids:` list may mean "every column").
 */
export function buildCreateMutation(readBack: string[][]): string {
  const vars = ['$board: ID!'];
  const fields = ['complexity { query after reset_in_x_seconds }'];
  readBack.forEach((cols, i) => {
    vars.push(`$n${i}: String!`, `$c${i}: JSON`);
    let select = 'id';
    if (cols.length > 0) {
      vars.push(`$r${i}: [String!]`);
      select += ` column_values (ids: $r${i}) { id ... on BoardRelationValue { linked_item_ids } }`;
    }
    fields.push(`i${i}: create_item (board_id: $board, item_name: $n${i}, column_values: $c${i}, ` +
      `create_labels_if_missing: true) { ${select} }`);
  });
  return `mutation (${vars.join(', ')}) {\n  ${fields.join('\n  ')}\n}`;
}

/**
 * Shared across a worker pool: once a response shows too little complexity budget left for
 * every worker to send one more batch of the same cost, new sends wait for the reset instead of
 * burning retries on ComplexityException.
 */
export class ComplexityGate {
  private resumeAt = 0;
  constructor(private sleep: (ms: number) => Promise<void>, private now: () => number = Date.now,
    private reserveBatches = 1) {}

  observe(c: Complexity | null | undefined): void {
    if (!c || typeof c.after !== 'number' || typeof c.query !== 'number') return;
    if (c.after < c.query * this.reserveBatches) {
      this.resumeAt = Math.max(this.resumeAt, this.now() + (c.reset_in_x_seconds ?? 60) * 1000);
    }
  }

  async ready(): Promise<void> {
    const wait = this.resumeAt - this.now();
    if (wait > 0) await this.sleep(wait);
  }
}

/**
 * Runs `fn` over `tasks` with at most `concurrency` in flight. After any task throws, no new
 * task starts (in-flight ones finish) and the first error is rethrown — a crash, not a skip.
 */
export async function runPool<T>(tasks: T[], concurrency: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < tasks.length) {
      const t = tasks[next++]!;
      try { await fn(t); } catch (err) { failed = true; throw err; }
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, () => worker()));
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) throw rejected.reason;
}

// relationsDropped: this is the one retry of a definitely-rejected entry without its inline
// relations (CreateEntry.plainColValues).
interface Pending { entry: CreateEntry; relationsDropped?: boolean }

/**
 * Creates `entries` on one board with batched `create_item`s, reporting each entry's outcome
 * through `onOutcome` as soon as it is known (the caller ledgers it). See the module comment for
 * the recovery rules.
 * @throws only if `onOutcome` throws (e.g. the ledger can't be written) — treated as a crash.
 */
export async function createBatch(opts: {
  client: MondayClient; boardId: number; sfIdColId: string; entries: CreateEntry[];
  /** Pause before a recovery lookup, so a just-committed item is visible to search. */
  lookupDelayMs: number;
  gate?: ComplexityGate;
  onOutcome: (o: CreateOutcome) => Promise<void>;
}): Promise<void> {
  const { client, boardId, sfIdColId, lookupDelayMs, gate, onOutcome } = opts;
  const queue: Pending[][] = [opts.entries.map((entry) => ({ entry }))];

  while (queue.length > 0) {
    const group = queue.shift()!;
    if (group.length === 0) continue;
    await gate?.ready();

    const confirmed: { p: Pending; itemId: string; linked?: Record<string, string[]> }[] = [];
    const definite = new Map<Pending, string>(); // entry → Monday's rejection message
    const unknown: Pending[] = [];
    // Created but the id didn't come back (an error under the alias's read-back selection):
    // looked up and adopted, else failed — never re-sent, whatever the group size.
    const committed = new Map<Pending, string>();
    // Definite rejections of the alias itself (error path === [alias], data present) — the only
    // outcome that may be retried, and only without inline relations.
    const rejectedByAlias = new Set<Pending>();
    let wholeRequestError: string | undefined; // the request failed as a whole, not per alias
    let wait = 0;
    try {
      const vars: Record<string, unknown> = { board: String(boardId) };
      group.forEach((p, i) => {
        vars[`n${i}`] = p.entry.name;
        vars[`c${i}`] = JSON.stringify(p.entry.colValues);
        if (p.entry.readBack?.length) vars[`r${i}`] = p.entry.readBack;
      });
      type AliasData = { id?: string; column_values?: { id: string; linked_item_ids?: (string | number)[] }[] } | null;
      const res = await client.gqlPartial<Record<string, AliasData | Complexity>>(
        buildCreateMutation(group.map((p) => p.entry.readBack ?? [])), vars);
      gate?.observe(res.data?.['complexity'] as Complexity | undefined);
      wait = retryInMs(res.errors);
      if (res.data === null) {
        wholeRequestError = res.errors.map((e) => e.message).join('; ') || 'no data';
        unknown.push(...group);
      } else {
        group.forEach((p, i) => {
          const alias = `i${i}`;
          const d = res.data![alias] as AliasData | undefined;
          if (d?.id) {
            const linked = d.column_values
              ? Object.fromEntries(d.column_values.map((c) => [c.id, (c.linked_item_ids ?? []).map(String)]))
              : undefined;
            confirmed.push({ p, itemId: String(d.id), ...(linked ? { linked } : {}) });
            return;
          }
          const aliasErrors = res.errors.filter((e) => e.path?.[0] === alias);
          // An error below the alias (its column_values read-back) is raised only after
          // create_item returned: the item exists, we just lost its id.
          const deeper = aliasErrors.find((e) => (e.path?.length ?? 0) > 1);
          if (deeper) { committed.set(p, deeper.message); return; }
          const own = aliasErrors.find((e) => e.path?.length === 1);
          if (own && !isRejectedBeforeRunning(own)) {
            definite.set(p, own.message);
            rejectedByAlias.add(p); // Monday refused this create itself — the only strippable case
          } else unknown.push(p);
        });
      }
    } catch (err) {
      unknown.push(...group);
      if (!(err instanceof AmbiguousWriteError)) wholeRequestError = String(err);
    }

    for (const c of confirmed) {
      await onOutcome({ sfId: c.p.entry.sfId, kind: 'created', itemId: c.itemId,
        ...(c.linked ? { linked: c.linked } : {}), ...(c.p.relationsDropped ? { relationsDropped: true } : {}) });
    }

    const toCheck = [...definite.keys(), ...committed.keys(), ...unknown];
    if (toCheck.length === 0) continue;

    if (lookupDelayMs > 0) await client.sleep(lookupDelayMs);
    let found: Map<string, string[]>;
    try {
      found = await findItemIdsBySfIds(client, boardId, sfIdColId, toCheck.map((p) => p.entry.sfId));
    } catch (err) {
      for (const p of toCheck) {
        await onOutcome({ sfId: p.entry.sfId, kind: 'failed', error:
          `create outcome unknown and the recovery lookup failed (${String(err)}) — not re-sent; ` +
          `the next run's board scan adopts it if it landed` });
      }
      continue;
    }

    const resend: Pending[] = [];
    for (const p of toCheck) {
      const ids = found.get(p.entry.sfId);
      if (ids?.length) {
        await onOutcome({ sfId: p.entry.sfId, kind: 'adopted', itemId: ids[0]!, itemIds: ids });
      } else if (committed.has(p)) {
        await onOutcome({ sfId: p.entry.sfId, kind: 'failed', error:
          `create_item committed but its response was incomplete (${committed.get(p)!}) and the ` +
          `lookup didn't find it yet — not re-sent; the next run's board scan adopts it` });
      } else if (rejectedByAlias.has(p) && p.entry.plainColValues && !p.relationsDropped) {
        // Monday rejected this entry outright (the request completed, so nothing is still in
        // flight) and it carried inline relations — a deleted, archived or wrong-board target
        // would otherwise fail its create on every run. Retry once without them; the link pass
        // then owns those links and the #21 gate handles their failures.
        const { readBack: _dropped, ...rest } = p.entry;
        resend.push({ entry: { ...rest, colValues: p.entry.plainColValues }, relationsDropped: true });
      } else if (definite.has(p)) {
        await onOutcome({ sfId: p.entry.sfId, kind: 'failed', error: `monday: ${definite.get(p)!}` });
      } else {
        // Outcome unknown (timeout, 5xx, network error, cut-off body, whole-request error, null
        // alias), whatever the request size: Monday may still be committing after we gave up,
        // and search may lag, so a miss here proves nothing. Never re-send in this run — the
        // next run's start-of-run board scan adopts whatever landed and creates the rest.
        await onOutcome({ sfId: p.entry.sfId, kind: 'failed', error:
          `batched create_item outcome unknown (ambiguous) and not found by lookup — not re-sent ` +
          `this run; the next run's board scan adopts it if it landed, else creates it` +
          (wholeRequestError ? ` (error: ${wholeRequestError})` : '') });
      }
    }
    if (resend.length === 0) continue;
    if (wait > 0) await client.sleep(wait);
    // The relation-less retry goes alone, so a second rejection can't touch other entries.
    queue.push(...resend.map((p) => [p]));
  }
}
