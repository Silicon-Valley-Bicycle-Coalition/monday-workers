# Donor Letter Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff email a donor a "your giving letter is ready" notification by clicking a button
on their Monday.com Donor item, reusing the existing letter renderer and magic-link auth unchanged.

**Architecture:** A Monday webhook (subscribed to the button column's value-change event) hits a new
route on the existing `donor-portal` Hono app. The route dedupes/records the send in a new D1
table and enqueues to a new Cloudflare Queue; a queue consumer loads the letter data, mints a
magic-link token, and sends the notification email via Resend. Same webhook→D1→queue→consumer
shape as this Worker's `changeRequests` feature and as `donation-rollups`' webhook.

**Tech Stack:** Hono, TypeScript, D1, Cloudflare Queues, Resend, Vitest (`@cloudflare/vitest-plugin`
for D1-backed tests).

**Spec:** `docs/superpowers/specs/2026-08-24-donor-letter-emails-design.md`

## Global Constraints

- Email content is a notification only (subject/body says the letter is ready), with a magic link
  to the **portal home** — never the letter itself, never a PDF, never a direct-to-letter redirect.
- Always sends the **most recently completed calendar year** with at least one gift — no year
  picker, no staff-chosen year.
- The whole feature is inert whenever `taxLetter` config isn't signed off (`lettersEnabled(config)`
  returns false) — matches the gate the portal-facing letters already use. A blocked send is
  recorded as `skipped`, not retried.
- A donor+year pair is only ever sent once. A repeat trigger (double-click, redelivered webhook) is
  a silent no-op, backed by a D1 dedupe/audit table (`letter_sends`).
- No new `config/svbc.json` keys — reuses `resend`, `auth`, `taxLetter` as they exist today.
- Follow the existing webhook-driven-Worker shape exactly: route validates + dedupes into D1, then
  enqueues; the queue consumer does the real work (email send) and is where retries/DLQ live.
- The Monday webhook's shared-secret check follows the exact convention already used in
  `donation-rollups/src/webhook/route.ts` (a `?secret=` query param, plain `!==` comparison, and
  the `{ challenge }` echo-back handshake for Monday's subscription-verification request) — not a
  new pattern.

---

### Task 1: D1 store for letter sends

**Files:**
- Create: `donor-portal/migrations/0003_create_letter_sends.sql`
- Create: `donor-portal/src/db/letterSends.ts`
- Test: `donor-portal/src/db/letterSends.test.ts`

**Interfaces:**
- Produces: `LetterSendRow { id: number; donorItemId: string; year: number; status: 'queued' | 'sent' | 'skipped'; createdAt: string; sentAt: string | null }`, `LetterSendStore { findByDonorYear(donorItemId: string, year: number): Promise<{ id: number; status: 'queued' | 'sent' | 'skipped' } | null>; createQueued(params: { donorItemId: string; year: number; createdAt: string }): Promise<number>; getById(id: number): Promise<LetterSendRow | null>; markSent(id: number, sentAtISO: string): Promise<void>; markSkipped(id: number, atISO: string): Promise<void> }`, `D1LetterSendStore implements LetterSendStore` (constructor takes `D1Database`).

- [ ] **Step 1: Write the migration**

```sql
CREATE TABLE letter_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_item_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE UNIQUE INDEX idx_letter_sends_donor_year ON letter_sends (donor_item_id, year);
```

Save as `donor-portal/migrations/0003_create_letter_sends.sql`. The test setup file
(`test/apply-migrations.ts`, already wired into `vitest.config.ts` via `readD1Migrations`) picks up
every file in `migrations/` automatically — no other config change needed.

- [ ] **Step 2: Write the failing test**

```typescript
// donor-portal/src/db/letterSends.test.ts
import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1LetterSendStore } from './letterSends';

describe('D1LetterSendStore', () => {
  it('creates a queued row and reads it back by id', async () => {
    const store = new D1LetterSendStore(env.DB);
    const id = await store.createQueued({ donorItemId: 'donor-1', year: 2025, createdAt: '2026-08-24T10:00:00.000Z' });
    const row = await store.getById(id);
    expect(row).toEqual({
      id,
      donorItemId: 'donor-1',
      year: 2025,
      status: 'queued',
      createdAt: '2026-08-24T10:00:00.000Z',
      sentAt: null,
    });
  });

  it('returns null for an unknown id', async () => {
    const store = new D1LetterSendStore(env.DB);
    expect(await store.getById(999_999)).toBeNull();
  });

  it('finds an existing row by donor and year', async () => {
    const store = new D1LetterSendStore(env.DB);
    const id = await store.createQueued({ donorItemId: 'donor-2', year: 2024, createdAt: '2026-08-24T10:00:00.000Z' });
    expect(await store.findByDonorYear('donor-2', 2024)).toEqual({ id, status: 'queued' });
    expect(await store.findByDonorYear('donor-2', 2023)).toBeNull();
    expect(await store.findByDonorYear('other-donor', 2024)).toBeNull();
  });

  it('rejects a second row for the same donor and year', async () => {
    const store = new D1LetterSendStore(env.DB);
    await store.createQueued({ donorItemId: 'donor-3', year: 2025, createdAt: '2026-08-24T10:00:00.000Z' });
    await expect(
      store.createQueued({ donorItemId: 'donor-3', year: 2025, createdAt: '2026-08-24T10:01:00.000Z' })
    ).rejects.toThrow();
  });

  it('marks a row sent', async () => {
    const store = new D1LetterSendStore(env.DB);
    const id = await store.createQueued({ donorItemId: 'donor-4', year: 2025, createdAt: '2026-08-24T10:00:00.000Z' });
    await store.markSent(id, '2026-08-24T10:05:00.000Z');
    expect(await store.findByDonorYear('donor-4', 2025)).toEqual({ id, status: 'sent' });
    const row = await store.getById(id);
    expect(row?.sentAt).toBe('2026-08-24T10:05:00.000Z');
  });

  it('marks a row skipped', async () => {
    const store = new D1LetterSendStore(env.DB);
    const id = await store.createQueued({ donorItemId: 'donor-5', year: 2025, createdAt: '2026-08-24T10:00:00.000Z' });
    await store.markSkipped(id, '2026-08-24T10:05:00.000Z');
    expect(await store.findByDonorYear('donor-5', 2025)).toEqual({ id, status: 'skipped' });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run (from `donor-portal/`): `npm test -- src/db/letterSends.test.ts`
Expected: FAIL — `./letterSends` has no exported member `D1LetterSendStore` (module doesn't exist yet).

- [ ] **Step 4: Implement the store**

```typescript
// donor-portal/src/db/letterSends.ts
export interface LetterSendRow {
  id: number;
  donorItemId: string;
  year: number;
  status: 'queued' | 'sent' | 'skipped';
  createdAt: string;
  sentAt: string | null;
}

export interface LetterSendStore {
  findByDonorYear(donorItemId: string, year: number): Promise<{ id: number; status: 'queued' | 'sent' | 'skipped' } | null>;
  createQueued(params: { donorItemId: string; year: number; createdAt: string }): Promise<number>;
  getById(id: number): Promise<LetterSendRow | null>;
  markSent(id: number, sentAtISO: string): Promise<void>;
  markSkipped(id: number, atISO: string): Promise<void>;
}

export class D1LetterSendStore implements LetterSendStore {
  constructor(private db: D1Database) {}

  async findByDonorYear(donorItemId: string, year: number): Promise<{ id: number; status: 'queued' | 'sent' | 'skipped' } | null> {
    const row = await this.db
      .prepare(`SELECT id, status FROM letter_sends WHERE donor_item_id = ?1 AND year = ?2`)
      .bind(donorItemId, year)
      .first<{ id: number; status: 'queued' | 'sent' | 'skipped' }>();
    return row === null ? null : { id: row.id, status: row.status };
  }

  async createQueued(params: { donorItemId: string; year: number; createdAt: string }): Promise<number> {
    const result = await this.db
      .prepare(`INSERT INTO letter_sends (donor_item_id, year, created_at) VALUES (?1, ?2, ?3)`)
      .bind(params.donorItemId, params.year, params.createdAt)
      .run();
    return result.meta.last_row_id;
  }

  async getById(id: number): Promise<LetterSendRow | null> {
    const row = await this.db
      .prepare(`SELECT id, donor_item_id, year, status, created_at, sent_at FROM letter_sends WHERE id = ?1`)
      .bind(id)
      .first<{
        id: number;
        donor_item_id: string;
        year: number;
        status: 'queued' | 'sent' | 'skipped';
        created_at: string;
        sent_at: string | null;
      }>();
    if (row === null) return null;
    return {
      id: row.id,
      donorItemId: row.donor_item_id,
      year: row.year,
      status: row.status,
      createdAt: row.created_at,
      sentAt: row.sent_at,
    };
  }

  async markSent(id: number, sentAtISO: string): Promise<void> {
    await this.db
      .prepare(`UPDATE letter_sends SET status = 'sent', sent_at = ?1 WHERE id = ?2`)
      .bind(sentAtISO, id)
      .run();
  }

  async markSkipped(id: number, atISO: string): Promise<void> {
    await this.db
      .prepare(`UPDATE letter_sends SET status = 'skipped', sent_at = ?1 WHERE id = ?2`)
      .bind(atISO, id)
      .run();
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/db/letterSends.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add donor-portal/migrations/0003_create_letter_sends.sql donor-portal/src/db/letterSends.ts donor-portal/src/db/letterSends.test.ts
git commit -m "feat(donor-portal): add letter_sends D1 store"
```

---

### Task 2: Email sender — letter-ready notification

**Files:**
- Modify: `donor-portal/src/email/resend.ts`
- Modify: `donor-portal/src/email/resend.test.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `SendLetterReadyEmailParams { to: string; donorName: string; year: number; loginUrl: string }`; `EmailSender` interface gains `sendLetterReadyEmail(params: SendLetterReadyEmailParams): Promise<void>`; `ResendEmailSender` implements it.

- [ ] **Step 1: Read the existing test file for the mocking pattern**

Open `donor-portal/src/email/resend.test.ts` and note how `sendLoginEmail` is tested (a fake
`fetchFn` passed into `ResendEmailSender`'s constructor, asserting on the request body/URL and on
thrown errors for a non-ok response). The new test mirrors it exactly for the new method.

- [ ] **Step 2: Write the failing test**

Add to `donor-portal/src/email/resend.test.ts` (same file, alongside the existing
`describe('sendLoginEmail', ...)` block):

```typescript
describe('sendLetterReadyEmail', () => {
  it('posts to Resend with the letter-ready subject and a link to the portal', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const sender = new ResendEmailSender('key-123', 'letters@mail.bikesiliconvalley.org', 'SVBC', fetchFn);

    await sender.sendLetterReadyEmail({
      to: 'jane@example.org',
      donorName: 'Jane Example',
      year: 2025,
      loginUrl: 'https://portal.example.org/auth/callback?token=abc',
    });

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer key-123' }),
      })
    );
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.to).toEqual(['jane@example.org']);
    expect(body.subject).toBe('Your 2025 SVBC giving letter is ready');
    expect(body.html).toContain('https://portal.example.org/auth/callback?token=abc');
    expect(body.html).toContain('Jane Example');
  });

  it('throws on a non-ok Resend response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    const sender = new ResendEmailSender('key-123', 'a@example.org', 'SVBC', fetchFn);

    await expect(
      sender.sendLetterReadyEmail({ to: 'jane@example.org', donorName: 'Jane', year: 2025, loginUrl: 'https://x/callback' })
    ).rejects.toThrow('resend: HTTP 400');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/email/resend.test.ts`
Expected: FAIL — `sender.sendLetterReadyEmail is not a function`

- [ ] **Step 4: Implement the method**

In `donor-portal/src/email/resend.ts`, add the params interface, extend `EmailSender`, and add the
method to `ResendEmailSender`:

```typescript
export interface SendLetterReadyEmailParams {
  to: string;
  donorName: string;
  year: number;
  loginUrl: string;
}

export interface EmailSender {
  sendLoginEmail(params: SendLoginEmailParams): Promise<void>;
  sendLetterReadyEmail(params: SendLetterReadyEmailParams): Promise<void>;
}
```

And inside the `ResendEmailSender` class, after `sendLoginEmail`:

```typescript
  async sendLetterReadyEmail(params: SendLetterReadyEmailParams): Promise<void> {
    const response = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: `${this.fromName} <${this.fromAddress}>`,
        to: [params.to],
        subject: `Your ${params.year} SVBC giving letter is ready`,
        html: `<p>Hi ${params.donorName},</p><p>Your ${params.year} giving letter is ready to view in your donor portal.</p><p><a href="${params.loginUrl}">Log in to view it</a></p><p>This link expires soon and can only be used once.</p>`,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`resend: HTTP ${response.status}: ${body}`);
    }
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/email/resend.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: FAIL — every literal object typed `EmailSender` elsewhere in the codebase (e.g. in
`routes.test.ts`'s `makeDeps`) now misses `sendLetterReadyEmail`. This is expected; Task 6 fixes
`routes.test.ts`'s fixture. Confirm the *only* errors are about missing `sendLetterReadyEmail` on
`EmailSender`-typed values — if anything else fails, stop and investigate before continuing.

- [ ] **Step 7: Commit**

```bash
git add donor-portal/src/email/resend.ts donor-portal/src/email/resend.test.ts
git commit -m "feat(donor-portal): add sendLetterReadyEmail to the Resend sender"
```

---

### Task 3: Webhook payload validation

**Files:**
- Create: `donor-portal/src/letters/validateLetterWebhook.ts`
- Test: `donor-portal/src/letters/validateLetterWebhook.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `LetterWebhookEvent { donorItemId: string }`, `validateLetterWebhookBody(body: unknown): LetterWebhookEvent` (throws `Error` on a malformed body).

- [ ] **Step 1: Write the failing test**

```typescript
// donor-portal/src/letters/validateLetterWebhook.test.ts
import { describe, it, expect } from 'vitest';
import { validateLetterWebhookBody } from './validateLetterWebhook';

describe('validateLetterWebhookBody', () => {
  it('extracts the donor item id from a numeric pulseId', () => {
    expect(validateLetterWebhookBody({ event: { type: 'update_column_value', pulseId: 555, boardId: 18427756119 } })).toEqual({
      donorItemId: '555',
    });
  });

  it('extracts the donor item id from a string pulseId', () => {
    expect(validateLetterWebhookBody({ event: { pulseId: '555' } })).toEqual({ donorItemId: '555' });
  });

  it('throws when the body is not an object', () => {
    expect(() => validateLetterWebhookBody('nope')).toThrow('webhook body is not an object');
  });

  it('throws when there is no event object', () => {
    expect(() => validateLetterWebhookBody({})).toThrow('webhook body has no "event" object');
  });

  it('throws when the event has no pulseId', () => {
    expect(() => validateLetterWebhookBody({ event: { type: 'update_column_value' } })).toThrow('webhook event has no pulseId');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/letters/validateLetterWebhook.test.ts`
Expected: FAIL — module `./validateLetterWebhook` not found

- [ ] **Step 3: Implement validation**

```typescript
// donor-portal/src/letters/validateLetterWebhook.ts
export interface LetterWebhookEvent {
  donorItemId: string;
}

// Monday's webhook payload for a subscribed column-value-change event looks like:
//   { event: { type: 'update_column_value', pulseId, boardId, columnId, ... } }
// Only pulseId (the item id) matters here — the webhook subscription itself is scoped to the
// "Send Giving Letter" button column at subscribe time (see README operator setup), so there's
// no need to re-check columnId/boardId in code, matching donation-rollups' webhook/validate.ts.
export function validateLetterWebhookBody(body: unknown): LetterWebhookEvent {
  if (typeof body !== 'object' || body === null) {
    throw new Error('webhook body is not an object');
  }
  const event = (body as Record<string, unknown>).event;
  if (typeof event !== 'object' || event === null) {
    throw new Error('webhook body has no "event" object');
  }
  const pulseId = (event as Record<string, unknown>).pulseId;
  if (typeof pulseId !== 'number' && typeof pulseId !== 'string') {
    throw new Error('webhook event has no pulseId');
  }
  return { donorItemId: String(pulseId) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/letters/validateLetterWebhook.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add donor-portal/src/letters/validateLetterWebhook.ts donor-portal/src/letters/validateLetterWebhook.test.ts
git commit -m "feat(donor-portal): validate the letter-send webhook payload"
```

---

### Task 4: Trigger logic — dedupe and enqueue

**Files:**
- Modify: `donor-portal/src/types.ts`
- Create: `donor-portal/src/letters/triggerLetterSend.ts`
- Test: `donor-portal/src/letters/triggerLetterSend.test.ts`

**Interfaces:**
- Consumes: `LetterSendStore` (Task 1, `../db/letterSends`), `MondayClient` (`../monday/client`),
  `listLetterYears(donorItemIds: string[], monday: MondayClient, now: Date): Promise<{ donorId: string; donorName: string; years: number[] }[]>` (existing, `./loadLetterData` — `years` is sorted
  descending, so `years[0]` is the most recently completed year).
- Produces: `LetterSendQueueMessage { sendId: number }` (in `types.ts`, re-exported from this
  module), `TriggerLetterSendResult = { kind: 'queued' } | { kind: 'duplicate' } | { kind: 'no-eligible-year' } | { kind: 'invalid'; message: string }`, `triggerLetterSend(donorItemId: string, deps: { monday: MondayClient; store: LetterSendStore; queue: { send(message: LetterSendQueueMessage): Promise<void> }; now: () => Date }): Promise<TriggerLetterSendResult>`.

- [ ] **Step 1: Add the queue message type to `types.ts`**

In `donor-portal/src/types.ts`, next to the existing `ChangeQueueMessage` (same import-cycle
rationale — this type is used by `Env`, which would otherwise have to import from a module that
imports `MondayClient`, which imports `types.ts`):

```typescript
// See the comment on ChangeQueueMessage above — same import-cycle avoidance.
export interface LetterSendQueueMessage {
  sendId: number;
}
```

Also add the new queue binding to `Env`:

```typescript
export interface Env extends Cloudflare.Env {
  MONDAY_API_TOKEN: string;
  RESEND_API_KEY: string;
  CHANGE_QUEUE: Queue<ChangeQueueMessage>;
  LETTER_SEND_QUEUE: Queue<LetterSendQueueMessage>;
  LETTER_WEBHOOK_SECRET: string;
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// donor-portal/src/letters/triggerLetterSend.test.ts
import { describe, it, expect, vi } from 'vitest';
import { triggerLetterSend } from './triggerLetterSend';
import type { LetterSendStore } from '../db/letterSends';
import type { MondayClient } from '../monday/client';

function fakeStore(overrides: Partial<LetterSendStore> = {}): LetterSendStore {
  return {
    findByDonorYear: vi.fn().mockResolvedValue(null),
    createQueued: vi.fn().mockResolvedValue(42),
    getById: vi.fn().mockResolvedValue(null),
    markSent: vi.fn().mockResolvedValue(undefined),
    markSkipped: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeMonday(donations: { date: string; amount: string; description: string }[]): MondayClient {
  return {
    getDonorPortalData: vi.fn().mockResolvedValue({
      id: 'donor-1',
      name: 'Jane Example',
      membershipStatus: 'Active',
      membershipTier: 'Champion',
      totalDonated: '$100.00',
      donations,
    }),
  } as unknown as MondayClient;
}

function makeDeps(overrides: { store?: LetterSendStore; monday?: MondayClient } = {}) {
  return {
    store: overrides.store ?? fakeStore(),
    monday: overrides.monday ?? fakeMonday([{ date: '2025-03-01', amount: '$50.00', description: 'Gift' }]),
    queue: { send: vi.fn().mockResolvedValue(undefined) },
    now: () => new Date('2026-08-24T10:00:00.000Z'),
  };
}

describe('triggerLetterSend', () => {
  it('rejects an empty donor item id', async () => {
    const deps = makeDeps();
    const result = await triggerLetterSend('', deps);
    expect(result.kind).toBe('invalid');
    expect(deps.queue.send).not.toHaveBeenCalled();
  });

  it('reports no-eligible-year when the donor has no completed-year gifts', async () => {
    const deps = makeDeps({ monday: fakeMonday([]) });
    const result = await triggerLetterSend('donor-1', deps);
    expect(result).toEqual({ kind: 'no-eligible-year' });
  });

  it('creates a queued row and enqueues it for a fresh donor+year', async () => {
    const store = fakeStore();
    const deps = makeDeps({ store });
    const result = await triggerLetterSend('donor-1', deps);

    expect(result).toEqual({ kind: 'queued' });
    expect(store.createQueued).toHaveBeenCalledWith({ donorItemId: 'donor-1', year: 2025, createdAt: '2026-08-24T10:00:00.000Z' });
    expect(deps.queue.send).toHaveBeenCalledWith({ sendId: 42 });
  });

  it('is a silent no-op for a donor+year already sent', async () => {
    const store = fakeStore({ findByDonorYear: vi.fn().mockResolvedValue({ id: 7, status: 'sent' }) });
    const deps = makeDeps({ store });
    const result = await triggerLetterSend('donor-1', deps);

    expect(result).toEqual({ kind: 'duplicate' });
    expect(store.createQueued).not.toHaveBeenCalled();
    expect(deps.queue.send).not.toHaveBeenCalled();
  });

  it('re-sends the queue message for a stranded queued row instead of creating a new one', async () => {
    const store = fakeStore({ findByDonorYear: vi.fn().mockResolvedValue({ id: 7, status: 'queued' }) });
    const deps = makeDeps({ store });
    const result = await triggerLetterSend('donor-1', deps);

    expect(result).toEqual({ kind: 'duplicate' });
    expect(store.createQueued).not.toHaveBeenCalled();
    expect(deps.queue.send).toHaveBeenCalledWith({ sendId: 7 });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/letters/triggerLetterSend.test.ts`
Expected: FAIL — module `./triggerLetterSend` not found

- [ ] **Step 4: Implement the trigger logic**

```typescript
// donor-portal/src/letters/triggerLetterSend.ts
import type { MondayClient } from '../monday/client';
import type { LetterSendStore } from '../db/letterSends';
import type { LetterSendQueueMessage } from '../types';
import { listLetterYears } from './loadLetterData';

// Re-exported so importers of this module don't also need to import ../types directly for the
// queue message shape — same convention as ChangeQueueMessage's re-export from submitChangeRequest.ts.
export type { LetterSendQueueMessage };

export type TriggerLetterSendResult =
  | { kind: 'queued' }
  | { kind: 'duplicate' }
  | { kind: 'no-eligible-year' }
  | { kind: 'invalid'; message: string };

export interface TriggerLetterSendDeps {
  monday: MondayClient;
  store: LetterSendStore;
  queue: { send(message: LetterSendQueueMessage): Promise<void> };
  now: () => Date;
}

export async function triggerLetterSend(donorItemId: string, deps: TriggerLetterSendDeps): Promise<TriggerLetterSendResult> {
  if (donorItemId.length === 0) {
    return { kind: 'invalid', message: 'Missing donor item id.' };
  }

  const now = deps.now();
  const [listing] = await listLetterYears([donorItemId], deps.monday, now);
  const year = listing?.years[0];
  if (year === undefined) {
    return { kind: 'no-eligible-year' };
  }

  const existing = await deps.store.findByDonorYear(donorItemId, year);
  if (existing !== null) {
    // A 'queued' match means an earlier trigger's row was written but its queue.send either
    // never ran or threw — re-send it now so the consumer (idempotent on status) gets another
    // chance, instead of leaving the row stranded with no message ever in flight. Same pattern
    // as submitChangeRequest's dedupe-hit handling.
    if (existing.status === 'queued') {
      await deps.queue.send({ sendId: existing.id });
    }
    return { kind: 'duplicate' };
  }

  const id = await deps.store.createQueued({ donorItemId, year, createdAt: now.toISOString() });
  await deps.queue.send({ sendId: id });
  return { kind: 'queued' };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/letters/triggerLetterSend.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: same pre-existing `sendLetterReadyEmail`-related errors as Task 2 left, nothing new.

- [ ] **Step 7: Commit**

```bash
git add donor-portal/src/types.ts donor-portal/src/letters/triggerLetterSend.ts donor-portal/src/letters/triggerLetterSend.test.ts
git commit -m "feat(donor-portal): add letter-send dedupe and enqueue logic"
```

---

### Task 5: Queue consumer — send the email

**Files:**
- Create: `donor-portal/src/letters/processLetterSendBatch.ts`
- Test: `donor-portal/src/letters/processLetterSendBatch.test.ts`

**Interfaces:**
- Consumes: `LetterSendStore` (Task 1), `LetterSendQueueMessage` (Task 4, `../types`),
  `EmailSender.sendLetterReadyEmail` (Task 2), `MagicLinkTokenStore.createToken` (existing,
  `../db/tokens`), `generateToken()` (existing, `../crypto/token`), `sha256Hex()` (existing,
  `../crypto/hash`), `loadLetterData(donorItemId, year, monday, taxLetter, now)` (existing,
  `./loadLetterData`), `lettersEnabled(config)` (existing, `../config`), `Config` (`../types`).
- Produces: `QueueMessageLike<T> { body: T; ack(): void; retry(): void }`,
  `ProcessLetterSendBatchDeps { store: LetterSendStore; monday: MondayClient; tokenStore: MagicLinkTokenStore; emailSender: EmailSender; config: Config; now: () => Date }`,
  `processLetterSendBatch(messages: QueueMessageLike<LetterSendQueueMessage>[], deps: ProcessLetterSendBatchDeps): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```typescript
// donor-portal/src/letters/processLetterSendBatch.test.ts
import { describe, it, expect, vi } from 'vitest';
import { processLetterSendBatch } from './processLetterSendBatch';
import type { LetterSendStore, LetterSendRow } from '../db/letterSends';
import type { MondayClient } from '../monday/client';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/resend';
import type { Config } from '../types';

const row: LetterSendRow = {
  id: 42,
  donorItemId: 'donor-1',
  year: 2025,
  status: 'queued',
  createdAt: '2026-08-24T09:00:00.000Z',
  sentAt: null,
};

const config: Config = {
  monday: { apiUrl: 'x', donorsBoardId: 1, donationsBoardId: 2, organizationsBoardId: 3, columns: {} as never },
  resend: { fromAddress: 'a@example.org', fromName: 'Test' },
  auth: { magicLinkTtlMinutes: 15, sessionTtlHours: 24, portalBaseUrl: 'https://portal.example.org' },
  rateLimit: { emailWindowSeconds: 900, emailMaxAttempts: 5 },
  taxLetter: {
    orgLegalName: 'SVBC',
    ein: '00-0000000',
    orgAddress: 'addr',
    signatureName: 'Alex',
    signatureTitle: 'ED',
    plainStatement: 'plain',
    benefitStatement: 'benefit',
    benefitTiers: ['Champion'],
  },
  changeRequests: {
    boardId: 99,
    columns: { donorLink: 'c1', field: 'c2', oldValue: 'c3', newValue: 'c4', submittedAt: 'c5' },
    dedupeWindowHours: 72,
    retentionDays: 180,
  },
};

function makeMessage(sendId: number) {
  return { body: { sendId }, ack: vi.fn(), retry: vi.fn() };
}

function fakeStore(getResult: LetterSendRow | null): LetterSendStore {
  return {
    findByDonorYear: vi.fn(),
    createQueued: vi.fn(),
    getById: vi.fn().mockResolvedValue(getResult),
    markSent: vi.fn().mockResolvedValue(undefined),
    markSkipped: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeMonday(): MondayClient {
  return {
    getDonorPortalData: vi.fn().mockResolvedValue({
      id: 'donor-1',
      name: 'Jane Example',
      membershipStatus: 'Active',
      membershipTier: 'Champion',
      totalDonated: '$50.00',
      donations: [{ date: '2025-03-01', amount: '$50.00', description: 'Gift' }],
    }),
    getDonorContactInfo: vi.fn().mockResolvedValue({
      id: 'donor-1', name: 'Jane Example', email: 'jane@example.org', address: '1 Old St', phone: '555-0100',
    }),
  } as unknown as MondayClient;
}

function fakeTokenStore(): MagicLinkTokenStore {
  return { createToken: vi.fn().mockResolvedValue(undefined), consumeToken: vi.fn() };
}

function fakeEmailSender(): EmailSender {
  return { sendLoginEmail: vi.fn(), sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined) };
}

describe('processLetterSendBatch', () => {
  it('sends the email, marks sent, and acks', async () => {
    const store = fakeStore(row);
    const monday = fakeMonday();
    const tokenStore = fakeTokenStore();
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);

    await processLetterSendBatch([message], { store, monday, tokenStore, emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z') });

    expect(tokenStore.createToken).toHaveBeenCalledWith(
      expect.objectContaining({ donorItemIds: ['donor-1'] })
    );
    expect(emailSender.sendLetterReadyEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'jane@example.org', donorName: 'Jane Example', year: 2025 })
    );
    const sentEmailUrl = (emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mock.calls[0][0].loginUrl;
    expect(sentEmailUrl).toContain('https://portal.example.org/auth/callback?token=');
    expect(store.markSent).toHaveBeenCalledWith(42, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('acks an already-sent row without re-sending (redelivery idempotency)', async () => {
    const store = fakeStore({ ...row, status: 'sent' });
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);

    await processLetterSendBatch([message], { store, monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config, now: () => new Date() });

    expect(emailSender.sendLetterReadyEmail).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it('marks skipped and acks when taxLetter is not signed off', async () => {
    const unsignedConfig: Config = { ...config, taxLetter: { ...config.taxLetter, ein: 'REPLACE_AFTER_SIGNOFF' } };
    const store = fakeStore(row);
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);

    await processLetterSendBatch([message], { store, monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config: unsignedConfig, now: () => new Date('2026-08-24T10:00:00.000Z') });

    expect(emailSender.sendLetterReadyEmail).not.toHaveBeenCalled();
    expect(store.markSkipped).toHaveBeenCalledWith(42, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
  });

  it('marks skipped and acks when the donor has no gifts in that year after all', async () => {
    const monday = { ...fakeMonday(), getDonorPortalData: vi.fn().mockResolvedValue({
      id: 'donor-1', name: 'Jane Example', membershipStatus: 'Active', membershipTier: 'Champion', totalDonated: '$0.00', donations: [],
    }) } as unknown as MondayClient;
    const store = fakeStore(row);
    const emailSender = fakeEmailSender();
    const message = makeMessage(42);

    await processLetterSendBatch([message], { store, monday, tokenStore: fakeTokenStore(), emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z') });

    expect(emailSender.sendLetterReadyEmail).not.toHaveBeenCalled();
    expect(store.markSkipped).toHaveBeenCalledWith(42, expect.any(String));
    expect(message.ack).toHaveBeenCalled();
  });

  it('retries when the row is missing (DLQ makes it visible)', async () => {
    const message = makeMessage(999);
    await processLetterSendBatch([message], { store: fakeStore(null), monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender: fakeEmailSender(), config, now: () => new Date() });
    expect(message.retry).toHaveBeenCalled();
  });

  it('retries on an email-send failure without marking sent', async () => {
    const store = fakeStore(row);
    const emailSender = fakeEmailSender();
    (emailSender.sendLetterReadyEmail as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('resend: HTTP 500'));
    const message = makeMessage(42);

    await processLetterSendBatch([message], { store, monday: fakeMonday(), tokenStore: fakeTokenStore(), emailSender, config, now: () => new Date('2026-08-24T10:00:00.000Z') });

    expect(store.markSent).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/letters/processLetterSendBatch.test.ts`
Expected: FAIL — module `./processLetterSendBatch` not found

- [ ] **Step 3: Implement the consumer**

```typescript
// donor-portal/src/letters/processLetterSendBatch.ts
import type { LetterSendStore } from '../db/letterSends';
import type { MondayClient } from '../monday/client';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/resend';
import type { Config, LetterSendQueueMessage } from '../types';
import { loadLetterData } from './loadLetterData';
import { lettersEnabled } from '../config';
import { generateToken } from '../crypto/token';
import { sha256Hex } from '../crypto/hash';

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface ProcessLetterSendBatchDeps {
  store: LetterSendStore;
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  emailSender: EmailSender;
  config: Config;
  now: () => Date;
}

export async function processLetterSendBatch(
  messages: QueueMessageLike<LetterSendQueueMessage>[],
  deps: ProcessLetterSendBatchDeps
): Promise<void> {
  for (const message of messages) {
    try {
      await processOne(message.body.sendId, deps);
      message.ack();
    } catch (err) {
      console.error(
        `donor-portal consumer: failed to process letter send ${message.body.sendId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      message.retry();
    }
  }
}

async function processOne(sendId: number, deps: ProcessLetterSendBatchDeps): Promise<void> {
  const row = await deps.store.getById(sendId);
  if (row === null) {
    // A queued message with no row is a bug worth surfacing — let retries exhaust into the DLQ
    // rather than acking it into silence.
    throw new Error(`no letter_sends row for id ${sendId}`);
  }
  if (row.status !== 'queued') {
    return; // redelivery after a crash between send/skip and ack — nothing to do
  }

  if (!lettersEnabled(deps.config)) {
    // taxLetter isn't signed off yet — a standing config gate, not a transient failure, so this
    // is a deliberate skip, not a retry candidate. Re-clicking the button after signoff creates
    // a fresh row (this one stays 'skipped' as a record of the earlier no-op).
    await deps.store.markSkipped(row.id, deps.now().toISOString());
    return;
  }

  const letterData = await loadLetterData(row.donorItemId, row.year, deps.monday, deps.config.taxLetter, deps.now());
  if (letterData === null) {
    // The donor's gifts for this year were removed/corrected between the webhook firing and this
    // consumer running — nothing to send.
    await deps.store.markSkipped(row.id, deps.now().toISOString());
    return;
  }

  const contact = await deps.monday.getDonorContactInfo(row.donorItemId);

  const rawToken = generateToken();
  const tokenHash = await sha256Hex(rawToken);
  const expiresAt = new Date(deps.now().getTime() + deps.config.auth.magicLinkTtlMinutes * 60_000).toISOString();
  await deps.tokenStore.createToken({ tokenHash, donorItemIds: [row.donorItemId], expiresAt });

  const loginUrl = `${deps.config.auth.portalBaseUrl}/auth/callback?token=${rawToken}`;
  await deps.emailSender.sendLetterReadyEmail({
    to: contact.email,
    donorName: contact.name,
    year: row.year,
    loginUrl,
  });

  await deps.store.markSent(row.id, deps.now().toISOString());
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/letters/processLetterSendBatch.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add donor-portal/src/letters/processLetterSendBatch.ts donor-portal/src/letters/processLetterSendBatch.test.ts
git commit -m "feat(donor-portal): add the letter-send queue consumer"
```

---

### Task 6: Wire the webhook route into the app

**Files:**
- Modify: `donor-portal/src/routes.ts`
- Modify: `donor-portal/src/routes.test.ts`

**Interfaces:**
- Consumes: `validateLetterWebhookBody` (Task 3), `triggerLetterSend` (Task 4), `LetterSendStore`
  (Task 1), `LetterSendQueueMessage` (Task 4).
- Produces: `AppDeps` gains `letterSendStore: LetterSendStore`,
  `letterQueue: { send(message: LetterSendQueueMessage): Promise<void> }`,
  `letterWebhookSecret: string`; new route `POST /webhooks/monday/letters`.

- [ ] **Step 1: Write the failing tests**

Add to `donor-portal/src/routes.test.ts`. First, update the shared fixtures near the top of the
file (around the existing `fakeChangeStore` and `makeDeps` — see Steps 1a/1b below), then add a new
`describe` block for the route itself.

**Step 1a — extend the `emailSender` fixture** (inside `makeDeps`, where `emailSender:` is
currently `{ sendLoginEmail: vi.fn().mockResolvedValue(undefined) }`):

```typescript
    emailSender: {
      sendLoginEmail: vi.fn().mockResolvedValue(undefined),
      sendLetterReadyEmail: vi.fn().mockResolvedValue(undefined),
    },
```

**Step 1b — add a `fakeLetterSendStore` helper** (alongside the existing `fakeChangeStore`):

```typescript
function fakeLetterSendStore(overrides: Partial<LetterSendStore> = {}): LetterSendStore {
  return {
    findByDonorYear: vi.fn().mockResolvedValue(null),
    createQueued: vi.fn().mockResolvedValue(42),
    getById: vi.fn().mockResolvedValue(null),
    markSent: vi.fn().mockResolvedValue(undefined),
    markSkipped: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
```

Add its import near the top: `import type { LetterSendStore } from './db/letterSends';`

**Step 1c — extend `makeDeps`** (alongside the existing `changeStore`/`changeQueue` entries):

```typescript
    letterSendStore: fakeLetterSendStore(),
    letterQueue: { send: vi.fn().mockResolvedValue(undefined) },
    letterWebhookSecret: 'shh',
```

**Step 1d — add the route's own test block**, mirroring
`donation-rollups/src/webhook/route.test.ts`'s style:

```typescript
describe('POST /webhooks/monday/letters', () => {
  function post(app: ReturnType<typeof createApp>, body: unknown, query = '') {
    return app.request(`/webhooks/monday/letters${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('rejects a request missing the configured secret with 401, before touching the body', async () => {
    const letterQueue = { send: vi.fn() };
    const app = createApp(makeDeps({ letterQueue }));
    const res = await post(app, { event: { pulseId: 1 } });
    expect(res.status).toBe(401);
    expect(letterQueue.send).not.toHaveBeenCalled();
  });

  it('rejects the wrong secret too', async () => {
    const app = createApp(makeDeps());
    const res = await post(app, { challenge: 'abc' }, '?secret=wrong');
    expect(res.status).toBe(401);
  });

  it('echoes the challenge verbatim during webhook-subscription verification', async () => {
    const app = createApp(makeDeps());
    const res = await post(app, { challenge: 'abc123' }, '?secret=shh');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('triggers a send for a valid event and returns its result kind', async () => {
    const letterSendStore = fakeLetterSendStore();
    const letterQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const monday = fakeMonday({});
    (monday.getDonorPortalData as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '555', name: 'Jane', membershipStatus: 'Active', membershipTier: 'Champion', totalDonated: '$50.00',
      donations: [{ date: '2025-03-01', amount: '$50.00', description: 'Gift' }],
    });
    const app = createApp(makeDeps({ letterSendStore, letterQueue, monday }));

    const res = await post(app, { event: { type: 'update_column_value', pulseId: 555, boardId: 1 } }, '?secret=shh');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: 'queued' });
    expect(letterSendStore.createQueued).toHaveBeenCalledWith(expect.objectContaining({ donorItemId: '555', year: 2025 }));
    expect(letterQueue.send).toHaveBeenCalledWith({ sendId: 42 });
  });

  it('rejects a malformed event body with 200 (no useful retry) and does not enqueue', async () => {
    const letterQueue = { send: vi.fn() };
    const app = createApp(makeDeps({ letterQueue }));
    const res = await post(app, { event: { type: 'update_column_value' } }, '?secret=shh'); // no pulseId
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(letterQueue.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/routes.test.ts`
Expected: FAIL — `AppDeps` is missing `letterSendStore`/`letterQueue`/`letterWebhookSecret`
(typecheck-level failure surfaced by vitest) and the route doesn't exist yet (404s in the new
tests).

- [ ] **Step 3: Add the route and deps to `routes.ts`**

Add imports near the top of `donor-portal/src/routes.ts`:

```typescript
import type { LetterSendStore } from './db/letterSends';
import type { LetterSendQueueMessage } from './types';
import { validateLetterWebhookBody } from './letters/validateLetterWebhook';
import { triggerLetterSend } from './letters/triggerLetterSend';
```

Extend `AppDeps`:

```typescript
export interface AppDeps {
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  sessionStore: SessionStore;
  attemptStore: LoginAttemptStore;
  emailSender: EmailSender;
  ipLimiter: IpRateLimiter;
  config: Config;
  now: () => Date;
  changeStore: ChangeRequestStore;
  changeQueue: { send(message: ChangeQueueMessage): Promise<void> };
  letterSendStore: LetterSendStore;
  letterQueue: { send(message: LetterSendQueueMessage): Promise<void> };
  letterWebhookSecret: string;
}
```

Add the route (placed with the other top-level, non-session routes — e.g. right after
`app.post('/logout', ...)`, before the closing `return app;`):

```typescript
  // Monday doesn't sign webhook payloads (no HMAC header to verify) — the standard mitigation
  // used elsewhere in this repo (donation-rollups) is a shared secret in the webhook URL itself,
  // set when subscribing and checked here.
  app.post('/webhooks/monday/letters', async (c) => {
    if (c.req.query('secret') !== deps.letterWebhookSecret) {
      return c.json({ ok: false }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 200);
    }

    // Monday's webhook-subscription verification handshake: echo the challenge back verbatim,
    // no other processing. Sent once, at subscription-creation time.
    if (typeof body === 'object' && body !== null && 'challenge' in body) {
      return c.json({ challenge: (body as { challenge: unknown }).challenge }, 200);
    }

    let event;
    try {
      event = validateLetterWebhookBody(body);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`donor-portal webhook: rejected letter-send delivery: ${errMsg}`);
      return c.json({ ok: false, error: errMsg }, 200);
    }

    const result = await triggerLetterSend(event.donorItemId, {
      monday: deps.monday,
      store: deps.letterSendStore,
      queue: deps.letterQueue,
      now: deps.now,
    });
    return c.json({ ok: true, result: result.kind }, 200);
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/routes.test.ts`
Expected: PASS (all existing tests plus the new ones)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors (this closes out the `sendLetterReadyEmail`/`AppDeps` gaps left open since
Tasks 2 and 4 — `index.ts` is still unwired, fixed in Task 7)

- [ ] **Step 6: Commit**

```bash
git add donor-portal/src/routes.ts donor-portal/src/routes.test.ts
git commit -m "feat(donor-portal): add the Monday letter-send webhook route"
```

---

### Task 7: Wire the Worker entrypoint

**Files:**
- Modify: `donor-portal/src/index.ts`
- Modify: `donor-portal/wrangler.jsonc`

**Interfaces:**
- Consumes: `D1LetterSendStore` (Task 1), `processLetterSendBatch` (Task 5), `Env.LETTER_SEND_QUEUE`
  / `Env.LETTER_WEBHOOK_SECRET` (Task 4), `AppDeps.letterSendStore`/`letterQueue`/`letterWebhookSecret`
  (Task 6).
- Produces: nothing new (glue only).

- [ ] **Step 1: Add the second queue to `wrangler.jsonc`**

In `donor-portal/wrangler.jsonc`, extend `queues`:

```jsonc
  "queues": {
    "producers": [
      { "queue": "donor-portal-change-requests", "binding": "CHANGE_QUEUE" },
      { "queue": "donor-portal-letter-emails", "binding": "LETTER_SEND_QUEUE" }
    ],
    "consumers": [
      {
        "queue": "donor-portal-change-requests",
        "max_retries": 3,
        // Single consumer at a time — Monday's per-token complexity budget punishes
        // concurrent writers during a backlog drain.
        "max_concurrency": 1,
        "dead_letter_queue": "donor-portal-change-requests-dlq"
      },
      {
        "queue": "donor-portal-letter-emails",
        "max_retries": 3,
        // Same reasoning as the change-requests consumer above.
        "max_concurrency": 1,
        "dead_letter_queue": "donor-portal-letter-emails-dlq"
      }
    ]
  },
```

- [ ] **Step 2: Wire `index.ts`'s `fetch()` and `queue()` handlers**

In `donor-portal/src/index.ts`, add imports:

```typescript
import { D1LetterSendStore } from './db/letterSends';
import { processLetterSendBatch } from './letters/processLetterSendBatch';
import type { Env, ChangeQueueMessage, LetterSendQueueMessage } from './types';
```

(replacing the existing `import type { Env, ChangeQueueMessage } from './types';` line)

In `fetch()`, add to the `createApp({...})` call:

```typescript
      letterSendStore: new D1LetterSendStore(env.DB),
      letterQueue: { send: (message) => env.LETTER_SEND_QUEUE.send(message).then(() => undefined) },
      letterWebhookSecret: env.LETTER_WEBHOOK_SECRET,
```

Replace the `queue()` handler — it now has two possible source queues, distinguished by
`batch.queue` (the queue name Cloudflare sets on every `MessageBatch`):

```typescript
  async queue(batch: MessageBatch<ChangeQueueMessage> | MessageBatch<LetterSendQueueMessage>, env: Env): Promise<void> {
    // Same lazy-validation rationale as fetch() above: config/svbc.json ships with placeholder
    // board/column ids until an operator fills them in, so validation can't happen at import time.
    const config = validateConfig(rawConfig);
    const monday = new HttpMondayClient(
      config.monday.apiUrl,
      env.MONDAY_API_TOKEN,
      config.monday.columns,
      config.monday.donorsBoardId ?? 0,
      config.monday.donationsBoardId ?? 0,
      config.monday.organizationsBoardId ?? 0
    );

    if (batch.queue === 'donor-portal-change-requests') {
      await processChangeQueueBatch((batch as MessageBatch<ChangeQueueMessage>).messages, {
        store: new D1ChangeRequestStore(env.DB),
        monday,
        config,
      });
      return;
    }

    if (batch.queue === 'donor-portal-letter-emails') {
      await processLetterSendBatch([...(batch as MessageBatch<LetterSendQueueMessage>).messages], {
        store: new D1LetterSendStore(env.DB),
        monday,
        tokenStore: new D1MagicLinkTokenStore(env.DB),
        emailSender: new ResendEmailSender(env.RESEND_API_KEY, config.resend.fromAddress, config.resend.fromName),
        config,
        now: () => new Date(),
      });
      return;
    }

    throw new Error(`donor-portal queue: unrecognized queue "${batch.queue}"`);
  },
```

Note: `processChangeQueueBatch` previously received `[...batch.messages]` (spread into a plain
array); keep that spread for the change-requests branch as it was, and use it for the new branch
too — both consumers expect a plain array of `QueueMessageLike<T>`, and `batch.messages` from the
real Cloudflare runtime is itself already directly usable (`Message<T>` satisfies
`QueueMessageLike<T>`'s shape), so this is purely to match the existing call style, not a
functional requirement.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS (every test file, including `index.test.ts`)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. This regenerates `worker-configuration.d.ts` from the updated
`wrangler.jsonc`, picking up `LETTER_SEND_QUEUE`'s binding shape.

- [ ] **Step 5: Commit**

```bash
git add donor-portal/src/index.ts donor-portal/wrangler.jsonc
git commit -m "feat(donor-portal): wire the letter-send queue and webhook secret into the Worker entrypoint"
```

---

### Task 8: Document operator setup

**Files:**
- Modify: `donor-portal/README.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add a new section documenting the feature and its setup**

In `donor-portal/README.md`, after the existing "## v2 — Year-end tax letters and change requests"
section, add:

```markdown
## v2.1 — Staff-triggered letter-ready emails

Design: `../docs/superpowers/specs/2026-08-24-donor-letter-emails-design.md`. A Button column on
the Donors board lets staff email a donor a "your letter is ready" notification — a magic link to
the portal home, not the letter content itself. Always sends the most recently completed year with
gifts; a donor+year is only ever sent once (tracked in the `letter_sends` D1 table). Inert until
`taxLetter` is signed off, same as the portal-facing letters.

**The automatic January cron this eventually enables is not built yet** — this ships the send
primitive (`POST /webhooks/monday/letters` → `donor-portal-letter-emails` queue →
`processLetterSendBatch`) that a scheduled trigger can reuse later without rework.

Operator setup, in addition to v1/v2 steps:

1. Add a Button column ("Send Giving Letter") to the Donors board.
2. Subscribe a Monday webhook to that column's value-change event
   (`create_webhook(board_id, url, event: change_specific_column_value, config: { columnId: "<button column id>" })`),
   targeting `https://<worker-domain>/webhooks/monday/letters?secret=<LETTER_WEBHOOK_SECRET>`.
3. Set the `LETTER_WEBHOOK_SECRET` Worker secret (`wrangler secret put LETTER_WEBHOOK_SECRET`) —
   must match the `secret` query param used in the webhook URL above.
4. Create the `donor-portal-letter-emails` queue and its `donor-portal-letter-emails-dlq` dead-letter
   queue before deploying (`wrangler queues create donor-portal-letter-emails` and
   `wrangler queues create donor-portal-letter-emails-dlq`).
5. Apply D1 migration `0003_create_letter_sends.sql`.
```

- [ ] **Step 2: Update the "Future candidates" list**

Change item 2 in the "Future candidates" list from:

```markdown
2. **January letter email distribution** — portal-only was a deliberate first-cut choice; the
   letter renderer (`src/letters/`) is an importable module so a future cron can email letters
   (or links to them) without rework. A staff-triggered per-donor "send letter" button is the
   discussed middle ground.
```

to:

```markdown
2. **Automatic January cron for letter emails** — the staff-triggered send (button column →
   webhook → email) shipped in v2.1 above; reuses the same `processLetterSendBatch` consumer. What
   remains is only the scheduled trigger: iterate all donors with a completed prior year and call
   `triggerLetterSend` for each, likely from the existing daily `scheduled()` handler once a year.
```

- [ ] **Step 3: Commit**

```bash
git add donor-portal/README.md
git commit -m "docs(donor-portal): document staff-triggered letter emails and their operator setup"
```

---

## Self-Review Notes

- **Spec coverage:** every "New pieces" bullet and every "Decisions" bullet in the spec maps to a
  task above (D1 store → Task 1; email → Task 2; webhook validation/route → Tasks 3, 6; dedupe →
  Task 4; consumer → Task 5; Monday-side setup and queue/secret provisioning → Tasks 7, 8).
- **Placeholder scan:** no TBD/TODO; every step has real code or a real doc diff.
- **Type consistency:** `LetterSendQueueMessage { sendId: number }` is used identically in Tasks 4,
  5, 6, and 7. `LetterSendStore`'s method names (`findByDonorYear`, `createQueued`, `getById`,
  `markSent`, `markSkipped`) are identical across Tasks 1, 4, 5, and 6's fakes. `TriggerLetterSendResult`'s
  `kind` values (`queued`/`duplicate`/`no-eligible-year`/`invalid`) match between Task 4's
  implementation and Task 6's route-level assertion (`result: 'queued'`).
- **Known limitation carried from the spec, not re-litigated here:** if the queue consumer's email
  send permanently fails (exhausts retries into the DLQ) *after* Task 1's row was already marked
  `sent` — which can't happen in this design, since `markSent` only runs *after* a successful send —
  there's no false-positive "sent" row. The spec's caveat about a stranded `queued` row after DLQ
  exhaustion stands: staff can check the DLQ for genuinely failed sends; not addressed by this plan
  (explicitly out of scope, per the spec).
