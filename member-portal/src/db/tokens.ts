import type { OrgGrant } from '../orgs/grants';

export interface NewMagicLinkToken {
  tokenHash: string;
  donorItemIds: string[];
  expiresAt: string;
  // Set on rows that carry a sign-in code: one row per request, found again by requestHash.
  requestHash?: string;
  codeHash?: string;
  emailHash?: string;
  orgGrants?: OrgGrant[];
}

export interface ConsumedToken {
  donorItemIds: string[];
  emailHash: string | null;
  orgGrants: OrgGrant[];
}

export interface CodeAttempt {
  codeHash: string;
  emailHash: string;
  // The code_failures row this try reserved in the address's daily budget, or null when the
  // budget is spent (the caller then refuses without comparing). A wrong guess keeps the slot; a
  // right one gives it back through CodeFailureStore.releaseFailure.
  failureSlot: number | null;
}

// The per-address window wrong guesses are counted over: failures at or after sinceISO, at most max.
export interface FailureBudget {
  sinceISO: string;
  max: number;
}

export interface MagicLinkTokenStore {
  createToken(params: NewMagicLinkToken): Promise<void>;
  consumeToken(tokenHash: string, nowISO: string): Promise<ConsumedToken | null>;
  // Counts one try against the row and, in the same transaction, reserves a slot in the address's
  // failure budget. null = nothing usable (expired, used, no code or address, unknown, or already
  // at maxAttempts), and then no slot is reserved either.
  takeCodeAttempt(requestHash: string, nowISO: string, maxAttempts: number, budget: FailureBudget): Promise<CodeAttempt | null>;
  // Single-use claim of the row by request hash, for a correct code. null = nothing to claim.
  claimByRequest(requestHash: string, nowISO: string): Promise<ConsumedToken | null>;
}

interface ConsumedRow {
  donor_item_ids: string;
  email_hash: string | null;
  org_grants: string | null;
}

function toConsumed(row: ConsumedRow): ConsumedToken {
  return {
    donorItemIds: JSON.parse(row.donor_item_ids) as string[],
    emailHash: row.email_hash,
    orgGrants: row.org_grants === null ? [] : (JSON.parse(row.org_grants) as OrgGrant[]),
  };
}

export class D1MagicLinkTokenStore implements MagicLinkTokenStore {
  constructor(private db: D1Database) {}

  async createToken(params: NewMagicLinkToken): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO magic_link_tokens (token_hash, donor_item_ids, expires_at, request_hash, code_hash, email_hash, org_grants)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .bind(
        params.tokenHash,
        JSON.stringify(params.donorItemIds),
        params.expiresAt,
        params.requestHash ?? null,
        params.codeHash ?? null,
        params.emailHash ?? null,
        params.orgGrants === undefined ? null : JSON.stringify(params.orgGrants)
      )
      .run();
  }

  async consumeToken(tokenHash: string, nowISO: string): Promise<ConsumedToken | null> {
    const claim = await this.db
      .prepare(
        `UPDATE magic_link_tokens SET used_at = ?2
         WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2`
      )
      .bind(tokenHash, nowISO)
      .run();

    if (claim.meta.changes === 0) {
      return null;
    }

    const row = await this.db
      .prepare(`SELECT donor_item_ids, email_hash, org_grants FROM magic_link_tokens WHERE token_hash = ?1`)
      .bind(tokenHash)
      .first<ConsumedRow>();

    return row === null ? null : toConsumed(row);
  }

  // One db.batch (one transaction, one round trip) whatever the request matched, so a request
  // that matched no donor costs the same as one that did (see verifyCode). The INSERT reserves only
  // when the UPDATE just counted a live try: changes() is the UPDATE's row count, so a row the
  // UPDATE skipped (already at the cap, expired, used) never takes a slot. Its count subquery and
  // insert run as one statement, so parallel tries can't all pass the count first.
  async takeCodeAttempt(requestHash: string, nowISO: string, maxAttempts: number, budget: FailureBudget): Promise<CodeAttempt | null> {
    const [attempt, slot] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE magic_link_tokens SET failed_code_attempts = failed_code_attempts + 1
           WHERE request_hash = ?1 AND used_at IS NULL AND expires_at > ?2
             AND failed_code_attempts < ?3 AND code_hash IS NOT NULL AND email_hash IS NOT NULL
           RETURNING code_hash, email_hash`
        )
        .bind(requestHash, nowISO, maxAttempts),
      this.db
        .prepare(
          `INSERT INTO code_failures (email_hash, failed_at)
           SELECT t.email_hash, ?2 FROM magic_link_tokens t
           WHERE changes() > 0
             AND t.request_hash = ?1 AND t.used_at IS NULL AND t.expires_at > ?2
             AND t.code_hash IS NOT NULL AND t.email_hash IS NOT NULL
             AND (SELECT COUNT(*) FROM code_failures f WHERE f.email_hash = t.email_hash AND f.failed_at >= ?3) < ?4
           RETURNING id`
        )
        .bind(requestHash, nowISO, budget.sinceISO, budget.max),
    ]);

    const row = (attempt!.results as { code_hash: string; email_hash: string }[])[0];
    if (row === undefined) return null;
    const reserved = (slot!.results as { id: number }[])[0];
    return { codeHash: row.code_hash, emailHash: row.email_hash, failureSlot: reserved?.id ?? null };
  }

  async claimByRequest(requestHash: string, nowISO: string): Promise<ConsumedToken | null> {
    const row = await this.db
      .prepare(
        `UPDATE magic_link_tokens SET used_at = ?2
         WHERE request_hash = ?1 AND used_at IS NULL AND expires_at > ?2
         RETURNING donor_item_ids, email_hash, org_grants`
      )
      .bind(requestHash, nowISO)
      .first<ConsumedRow>();

    return row === null ? null : toConsumed(row);
  }
}
