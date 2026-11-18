# quickbooks-sync: close the qb-to-monday duplicate-item window and propagate title renames

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close GitLab issue [#1](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/1)'s two parked, non-minor gaps in `quickbooks-sync`'s QuickBooks→Monday consumer path: the duplicate-Monday-item retry window, and Monday item titles never updating when the QuickBooks `DisplayName` (or other name field) changes.

**Architecture:** Mirror the durability pattern `processMondayToQb` already uses for its own retry-safety (durably persist an intermediate result to D1 *before* the next write, so a retry resumes instead of repeating a side effect) onto the QuickBooks→Monday direction's item-creation step. Separately, extend the existing `change_multiple_column_values` call (already used for every mapped-column update) to also carry monday.com's reserved `name` pseudo-column, confirmed live against monday.com's own API reference.

**Tech Stack:** TypeScript, Cloudflare Workers (Queues consumer), D1 (SQLite), Vitest (`@cloudflare/vitest-plugin` for D1-backed integration tests, plain `vitest` unit tests with hand-written fakes for the consumer).

**Spec:** GitLab issue [#1](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/1) ("quickbooks-sync: parked retry-idempotency and item-rename gaps from final review"). Item 3 in that issue (five minor, explicitly "no urgency" cleanup notes) is out of scope for this plan — see "Out of scope" below.

## Global Constraints

- ES modules, vanilla TS — no new dependencies.
- Conventional commits, one commit per task below.
- Every new/changed behavior gets a test before the implementation (TDD) — unit tests in `processBatch.test.ts` (fakes, fast, run via `npm test`), plus one integration test in `qbEvents.test.ts` (real D1 via Miniflare) for the new column round-tripping.
- Don't touch `processMondayToQb` (the monday-to-qb direction) — it already has this durability pattern; item 1 is qb-to-monday only.
- Don't reuse the `'fetched'` `SyncStatus` value for the new qb_events durable write: `'fetched'` already has a distinct, existing meaning for `qb_events` specifically — see Task 2's "Interfaces" note.

## Out of scope (explicitly deferred)

Issue [GL#1](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/1)'s "Item 3" minor notes are pre-existing, already-documented-as-low-risk observations (read-then-write idempotency guard, a harmless spurious-duplicate status reuse, an error-labeling edge case for a future migration, unconditional error-clearing, and a test-isolation note) — the issue itself says "no urgency." Fixing them isn't needed to close [GL#1](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/1)'s substantive gaps and isn't part of this plan.

---

### Task 1: `qb_events` gains a durable `pendingMondayItemId` column

**Files:**
- Create: `quickbooks-sync/migrations/0002_qb_events_pending_monday_item_id.sql`
- Modify: `quickbooks-sync/src/types.ts` (`QbEventRow`)
- Modify: `quickbooks-sync/src/db/qbEvents.ts` (`QbEventStatusPatch`, `D1QbEventRecord`, `toQbEventRow`, `D1QbEventStore.updateStatus`, `.getEvent`)
- Test: `quickbooks-sync/src/db/qbEvents.test.ts`

**Interfaces:**
- Produces: `QbEventRow.pendingMondayItemId: string | null` — read by Task 2's `processQbToMonday`. `QbEventStatusPatch.pendingMondayItemId?: string` — the write side Task 2 calls through `updateStatus`.

- [ ] **Step 1: Write the failing integration test**

Add to `quickbooks-sync/src/db/qbEvents.test.ts`, inside the existing `describe('D1QbEventStore', ...)` block:

```typescript
  it('round-trips pendingMondayItemId and leaves status untouched when only that field is patched', async () => {
    const store = new D1QbEventStore(env.DB);
    await store.insertEvent({
      eventId: 'evt-4',
      entityType: 'customer',
      qbId: 'qb-4',
      receivedAt: '2026-08-22T00:00:00.000Z',
    });
    await store.updateStatus('evt-4', 'queued');

    await store.updateStatus('evt-4', 'queued', { pendingMondayItemId: 'item-abc' });
    const row = await store.getEvent('evt-4');
    expect(row?.status).toBe('queued');
    expect(row?.pendingMondayItemId).toBe('item-abc');

    // A later patch that doesn't mention pendingMondayItemId must not clear it — same
    // COALESCE-on-write behavior the other patch fields already have.
    await store.updateStatus('evt-4', 'written', { writtenAt: '2026-08-22T01:00:00.000Z' });
    const finalRow = await store.getEvent('evt-4');
    expect(finalRow?.pendingMondayItemId).toBe('item-abc');
  });
```

Also add `pendingMondayItemId: null` to the two existing `toEqual({...})` object literals at lines 17-26 and (after the `updateStatus`/`getEvent` calls) wherever a full row is asserted — search the file for `toEqual({` and add the field to keep those assertions exhaustive.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd quickbooks-sync && npm test -- qbEvents.test.ts`
Expected: FAIL — `pendingMondayItemId` is `undefined` (property doesn't exist on the row / column doesn't exist in D1 yet), and the `toEqual` assertions fail because they're missing the new key entirely (or the store throws `no such column`).

- [ ] **Step 3: Add the migration**

Create `quickbooks-sync/migrations/0002_qb_events_pending_monday_item_id.sql`:

```sql
ALTER TABLE qb_events ADD COLUMN pending_monday_item_id TEXT;
```

- [ ] **Step 4: Wire the column through the type and store**

In `quickbooks-sync/src/types.ts`, add to `QbEventRow` (after `fetchedPayload`):

```typescript
  fetchedPayload: string | null;
  pendingMondayItemId: string | null;
```

In `quickbooks-sync/src/db/qbEvents.ts`:

```typescript
export interface QbEventStatusPatch {
  fetchedPayload?: string;
  pendingMondayItemId?: string;
  error?: string;
  writtenAt?: string;
}
```

```typescript
interface D1QbEventRecord {
  event_id: string;
  entity_type: EntityType;
  qb_id: string;
  fetched_payload: string | null;
  pending_monday_item_id: string | null;
  status: SyncStatus;
  error: string | null;
  received_at: string;
  written_at: string | null;
}
```

```typescript
function toQbEventRow(record: D1QbEventRecord): QbEventRow {
  return {
    eventId: record.event_id,
    entityType: record.entity_type,
    qbId: record.qb_id,
    fetchedPayload: record.fetched_payload,
    pendingMondayItemId: record.pending_monday_item_id,
    status: record.status,
    error: record.error,
    receivedAt: record.received_at,
    writtenAt: record.written_at,
  };
}
```

Replace the `updateStatus` method body:

```typescript
  async updateStatus(eventId: string, status: SyncStatus, patch: QbEventStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE qb_events SET
           status = ?2,
           fetched_payload = COALESCE(?3, fetched_payload),
           pending_monday_item_id = COALESCE(?4, pending_monday_item_id),
           error = ?5,
           written_at = COALESCE(?6, written_at)
         WHERE event_id = ?1`
      )
      .bind(
        eventId,
        status,
        patch.fetchedPayload ?? null,
        patch.pendingMondayItemId ?? null,
        patch.error ?? null,
        patch.writtenAt ?? null
      )
      .run();
  }
```

Replace the `getEvent` SELECT column list:

```typescript
  async getEvent(eventId: string): Promise<QbEventRow | null> {
    const record = await this.db
      .prepare(
        `SELECT event_id, entity_type, qb_id, fetched_payload, pending_monday_item_id, status, error, received_at, written_at
         FROM qb_events WHERE event_id = ?1`
      )
      .bind(eventId)
      .first<D1QbEventRecord>();
    return record === null ? null : toQbEventRow(record);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd quickbooks-sync && npm test -- qbEvents.test.ts`
Expected: PASS (all tests in the file, including the three pre-existing ones now asserting the extra field).

- [ ] **Step 6: Typecheck**

Run: `cd quickbooks-sync && npm run typecheck`
Expected: no errors (this will also flag any other `QbEventRow` object literal in the codebase that now needs the new field — fix any that appear before moving on).

- [ ] **Step 7: Commit**

```bash
git add quickbooks-sync/migrations/0002_qb_events_pending_monday_item_id.sql quickbooks-sync/src/types.ts quickbooks-sync/src/db/qbEvents.ts quickbooks-sync/src/db/qbEvents.test.ts
git commit -m "$(cat <<'EOF'
feat(quickbooks-sync): add qb_events.pending_monday_item_id column

Durable slot for the Monday item id created by a qb-to-monday sync,
written before the qb_monday_map row — groundwork for closing the
duplicate-item retry window in processQbToMonday.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Close the qb-to-monday duplicate-item retry window

**Files:**
- Modify: `quickbooks-sync/src/consumer/processBatch.ts` (`processQbToMonday`)
- Test: `quickbooks-sync/src/consumer/processBatch.test.ts`

**Interfaces:**
- Consumes: `QbEventRow.pendingMondayItemId` and `QbEventStatusPatch.pendingMondayItemId` from Task 1.
- Produces: no new exports; behavior change only in `processQbToMonday`'s "no existing mapping" branch.

**Design note (why not reuse `'fetched'`):** `processMondayToQb`'s equivalent fix writes its durable intermediate value under status `'fetched'` (see its comment) — but for `qb_events` specifically, `'fetched'` is *already* the status `quickbooks/webhook/route.ts` sets right after pulling the payload from QuickBooks, before the event is queued (`REACHED_QUEUE_STATUSES = ['queued', 'written']` in that file treats `'fetched'` as "not yet queued"). By the time the consumer runs, `event.status` is `'queued'`. Writing `'fetched'` from inside the consumer would move a queued event backward to a status other code reads as "not queued yet." Instead, pass `event.status` straight through so the patch changes only `pending_monday_item_id` and leaves status alone.

- [ ] **Step 1: Write the failing tests**

In `quickbooks-sync/src/consumer/processBatch.test.ts`, add `pendingMondayItemId: null` to the `qbEventRow()` factory's default object (next to `fetchedPayload`). Then add two tests inside `describe('processSyncQueueBatch — qb-to-monday', ...)`, after the existing "creates a new Monday item..." test:

```typescript
  it('durably records the created Monday item id before writing the mapping', async () => {
    const qbEventStore = fakeQbEventStore();
    const mapStore = fakeMapStore();
    const createItem = vi.fn().mockResolvedValue({ id: 'item-1' });
    const mondayClient = fakeMondayClient({ createItem });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore,
      mondayClient,
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    // The id lands in D1, status unchanged, before createMapping runs — so a createMapping
    // failure leaves a row a retry can resume from instead of calling createItem again.
    expect(qbEventStore.updateStatus).toHaveBeenNthCalledWith(1, 'evt-1', 'queued', {
      pendingMondayItemId: 'item-1',
    });
    expect(qbEventStore.updateStatus).toHaveBeenNthCalledWith(2, 'evt-1', 'written', {
      writtenAt: expect.any(String),
    });
  });

  it('resumes from a previously recorded Monday item id instead of creating a second item', async () => {
    const qbEventStore = fakeQbEventStore({
      getEvent: vi.fn().mockResolvedValue(qbEventRow({ pendingMondayItemId: 'item-from-earlier-attempt' })),
    });
    const mapStore = fakeMapStore();
    const createItem = vi.fn();
    const mondayClient = fakeMondayClient({ createItem });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore,
      mondayClient,
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(createItem).not.toHaveBeenCalled();
    expect(mapStore.createMapping).toHaveBeenCalledWith({
      entityType: 'customer',
      qbId: 'qb-1',
      mondayItemId: 'item-from-earlier-attempt',
      mondayBoardId: 111,
      createdAt: expect.any(String),
    });
    expect(message.ack).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd quickbooks-sync && npm test -- processBatch.test.ts`
Expected: FAIL — first new test: `updateStatus` was only called once (with `'written'`), not twice. Second new test: `createItem` was called (current code ignores `pendingMondayItemId`, which doesn't exist yet as a real field).

- [ ] **Step 3: Implement**

In `quickbooks-sync/src/consumer/processBatch.ts`, replace the `else` branch of `processQbToMonday` (currently lines 91-103):

```typescript
  } else {
    let mondayItemId = event.pendingMondayItemId;
    if (mondayItemId === null) {
      const created = await deps.mondayClient.createItem(boardId, itemName, columnValues);
      mondayItemId = created.id;

      // Durably record the created item's id, status unchanged, before writing the mapping.
      // A queue retry that resumes here (existing mapping lookup above still misses, because
      // createMapping below is what's about to fail or hasn't run yet) reuses this id instead
      // of calling createItem again — closing the duplicate-item window.
      await deps.qbEventStore.updateStatus(eventId, event.status, { pendingMondayItemId: mondayItemId });
    }

    await deps.mapStore.createMapping({
      entityType: event.entityType,
      qbId: event.qbId,
      mondayItemId,
      mondayBoardId: boardId,
      createdAt: new Date().toISOString(),
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd quickbooks-sync && npm test -- processBatch.test.ts`
Expected: PASS — all tests in the file, including the two new ones and the pre-existing "creates a new Monday item..." test (its `qbEventStore.updateStatus` assertion uses `toHaveBeenCalledWith`, which still matches the second call).

- [ ] **Step 5: Typecheck**

Run: `cd quickbooks-sync && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add quickbooks-sync/src/consumer/processBatch.ts quickbooks-sync/src/consumer/processBatch.test.ts
git commit -m "$(cat <<'EOF'
fix(quickbooks-sync): close qb-to-monday duplicate-item retry window

processQbToMonday now durably records a newly created Monday item's id
on the qb_events row before writing qb_monday_map. A retry that resumes
after a createMapping failure reuses that id instead of calling
createItem again, closing the parked gap from the final review
(gitlab#1, item 1).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Propagate QuickBooks name-field changes to the Monday item title

**Files:**
- Modify: `quickbooks-sync/src/consumer/processBatch.ts` (`processQbToMonday`)
- Test: `quickbooks-sync/src/consumer/processBatch.test.ts`

**Interfaces:**
- Consumes: `HttpMondayClient.changeColumnValues` (existing, unchanged signature) — confirmed via monday.com's own API reference (`developer.monday.com/api-reference/reference/name`) that its `change_multiple_column_values` mutation accepts a `"name"` key in `column_values` to rename the item itself, alongside ordinary mapped columns, in the same call. Not yet exercised against a live monday.com account — flag this when the MR is reviewed, same caveat the design spec already carries for this Worker's Monday client.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

In `quickbooks-sync/src/consumer/processBatch.test.ts`, update the existing "updates the existing Monday item instead of creating a duplicate" test's assertion:

```typescript
    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-existing', { text_col: 'Acme Co', name: 'Acme Co' });
```

(replacing the current `{ text_col: 'Acme Co' }`). Then add a new test directly after it:

```typescript
  it('renames the Monday item when the QuickBooks name field has changed', async () => {
    const qbEventStore = fakeQbEventStore({
      getEvent: vi.fn().mockResolvedValue(
        qbEventRow({ fetchedPayload: JSON.stringify({ Id: 'qb-1', DisplayName: 'Acme Co (renamed)' }) })
      ),
    });
    const mapStore = fakeMapStore({
      getByQbId: vi.fn().mockResolvedValue({
        entityType: 'customer',
        qbId: 'qb-1',
        mondayItemId: 'item-existing',
        mondayBoardId: 111,
        createdAt: '2026-08-22T00:00:00.000Z',
      }),
    });
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mondayClient = fakeMondayClient({ changeColumnValues });
    const message = fakeMessage({ direction: 'qb-to-monday', eventId: 'evt-1' });

    await processSyncQueueBatch([message], {
      qbEventStore,
      mondayEventStore: fakeMondayEventStore(),
      mapStore,
      mondayClient,
      quickBooksClient: fakeQuickBooksClient(),
      config,
    });

    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-existing', {
      text_col: 'Acme Co (renamed)',
      name: 'Acme Co (renamed)',
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd quickbooks-sync && npm test -- processBatch.test.ts`
Expected: FAIL — both assertions see `columnValues` without a `name` key (current code never adds one).

- [ ] **Step 3: Implement**

In `quickbooks-sync/src/consumer/processBatch.ts`, replace the `if (existing)` branch (currently lines 85-90):

```typescript
  if (existing) {
    // monday.com's Name column is a reserved pseudo-column addressable as column_id "name"
    // through the same change_multiple_column_values mutation used for every other mapped
    // column (developer.monday.com/api-reference/reference/name) — confirmed against monday's
    // public API docs, not yet exercised against a live account.
    await deps.mondayClient.changeColumnValues(boardId, existing.mondayItemId, {
      ...columnValues,
      name: itemName,
    });
  } else {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd quickbooks-sync && npm test -- processBatch.test.ts`
Expected: PASS — all tests, including the "links an invoice to its customer..." test (which hits the `else` branch, unaffected) and both update-path tests.

- [ ] **Step 5: Run the full quickbooks-sync test suite and typecheck**

Run: `cd quickbooks-sync && npm test && npm run typecheck`
Expected: PASS / no errors.

- [ ] **Step 6: Commit**

```bash
git add quickbooks-sync/src/consumer/processBatch.ts quickbooks-sync/src/consumer/processBatch.test.ts
git commit -m "$(cat <<'EOF'
fix(quickbooks-sync): propagate QuickBooks name-field changes to Monday item titles

Every qb-to-monday update now includes monday.com's reserved "name"
column alongside the ordinary mapped columns, so a QuickBooks
DisplayName/DocNumber/Name change reaches the Monday item's title
instead of leaving it stale. Confirmed against monday.com's public API
reference for the Name column; not yet exercised against a live
account (gitlab#1, item 2).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## After all tasks

- [ ] Run `cd quickbooks-sync && npm test && npm run typecheck` once more from a clean state to confirm nothing regressed across tasks.
- [ ] Open an MR from this branch against `main`, referencing and closing [#1](https://gitlab.com/silicon-valley-bicycle-coalition/svbc-monday-workers/-/issues/1), and noting in the description that item 3's minor cleanup notes remain deliberately out of scope (per the issue's own "no urgency").
