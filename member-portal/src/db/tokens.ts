import { LOGIN_CODE_DAILY_MAX, LOGIN_CODE_MAX_ATTEMPTS } from '../auth/loginCode';
import { isLocale, type Locale } from '../i18n/locales';

export interface NewMagicLinkToken {
  tokenHash: string;
  donorItemIds: string[];
  expiresAt: string;
  // Set only for an emailed link that also carries a login code; letter-ready rows omit them.
  requestHash?: string;
  codeHash?: string;
  // sha256 of the lowercased address, as login_attempts keys it. A code row without one never
  // matches a code.
  emailHash?: string;
  locale?: Locale;
  // Now, as an ISO string. Required with requestHash: the new row is compared against the
  // request's live rows as of this moment.
  createdAt?: string;
}

export interface ConsumedCode {
  donorItemIds: string[];
  locale: Locale | null;
}

export interface MagicLinkTokenStore {
  createToken(params: NewMagicLinkToken): Promise<void>;
  consumeToken(tokenHash: string, nowISO: string): Promise<string[] | null>;
  consumeCode(requestHash: string, codeHash: string, nowISO: string): Promise<ConsumedCode | null>;
}

const DAY_MS = 86_400_000;

export class D1MagicLinkTokenStore implements MagicLinkTokenStore {
  constructor(private db: D1Database) {}

  // A code row joins its request's checks, not a fresh budget: it starts at the highest count
  // among the request's live rows, so a resend never buys new guesses at an older code. A request
  // holds one address's codes at a time: live rows for any other address are retired (used_at)
  // first, so guesses at one address can't be charged to another's daily budget. Both statements
  // run in one D1 batch (a transaction).
  async createToken(params: NewMagicLinkToken): Promise<void> {
    const requestHash = params.requestHash ?? null;
    const createdAt = params.createdAt ?? null;
    if (requestHash !== null && createdAt === null) {
      throw new Error('createToken: createdAt is required with requestHash');
    }

    const insert = this.db
      .prepare(
        `INSERT INTO magic_link_tokens
           (token_hash, donor_item_ids, expires_at, request_hash, code_hash, email_hash, locale, code_attempts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(
           (SELECT MAX(code_attempts) FROM magic_link_tokens
            WHERE request_hash = ?4 AND used_at IS NULL AND expires_at > ?8),
           0))`
      )
      .bind(
        params.tokenHash,
        JSON.stringify(params.donorItemIds),
        params.expiresAt,
        requestHash,
        params.codeHash ?? null,
        params.emailHash ?? null,
        params.locale ?? null,
        createdAt
      );

    if (requestHash === null) {
      await insert.run();
      return;
    }

    const retireOtherAddresses = this.db
      .prepare(
        `UPDATE magic_link_tokens SET used_at = ?2
         WHERE request_hash = ?1 AND used_at IS NULL AND expires_at > ?2 AND email_hash IS NOT ?3`
      )
      .bind(requestHash, createdAt, params.emailHash ?? null);

    await this.db.batch([retireOtherAddresses, insert]);
  }

  async consumeToken(tokenHash: string, nowISO: string): Promise<string[] | null> {
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
      .prepare(`SELECT donor_item_ids FROM magic_link_tokens WHERE token_hash = ?1`)
      .bind(tokenHash)
      .first<{ donor_item_ids: string }>();

    return row === null ? null : (JSON.parse(row.donor_item_ids) as string[]);
  }

  // Every check, right or wrong, first counts against each live row of the request still under
  // LOGIN_CODE_MAX_ATTEMPTS, and only the rows it counted against can match, so no row ever
  // answers more than LOGIN_CODE_MAX_ATTEMPTS checks, even when checks race. The check is then
  // recorded against the address, at most LOGIN_CODE_DAILY_MAX per rolling 24 hours across every
  // browser; over that, no code for the address matches (links still work). Using the code burns
  // the row's link too (used_at).
  async consumeCode(requestHash: string, codeHash: string, nowISO: string): Promise<ConsumedCode | null> {
    const { results: counted } = await this.db
      .prepare(
        `UPDATE magic_link_tokens SET code_attempts = code_attempts + 1
         WHERE request_hash = ?1 AND used_at IS NULL AND expires_at > ?2 AND code_attempts < ?3
         RETURNING token_hash, email_hash`
      )
      .bind(requestHash, nowISO, LOGIN_CODE_MAX_ATTEMPTS)
      .all<{ token_hash: string; email_hash: string | null }>();

    // createToken keeps one address per request, so this is a single hash; rows without one
    // never match.
    const emailHashes = new Set(counted.flatMap((row) => (row.email_hash === null ? [] : [row.email_hash])));
    if (emailHashes.size !== 1) {
      return null;
    }
    const emailHash = [...emailHashes][0]!;

    // One statement, so the count and the insert are atomic, as in loginAttempts.tryReserve.
    const recorded = await this.db
      .prepare(
        `INSERT INTO login_code_checks (email_hash, checked_at)
         SELECT ?1, ?2
         WHERE (SELECT COUNT(*) FROM login_code_checks WHERE email_hash = ?1 AND checked_at > ?3) < ?4`
      )
      .bind(emailHash, nowISO, new Date(Date.parse(nowISO) - DAY_MS).toISOString(), LOGIN_CODE_DAILY_MAX)
      .run();
    if (recorded.meta.changes === 0) {
      return null;
    }

    const tokenHashes = counted.filter((row) => row.email_hash === emailHash).map((row) => row.token_hash);
    const row = await this.db
      .prepare(
        `UPDATE magic_link_tokens SET used_at = ?2
         WHERE token_hash IN (SELECT value FROM json_each(?1)) AND code_hash = ?3
           AND used_at IS NULL AND expires_at > ?2 AND code_attempts <= ?4
         RETURNING donor_item_ids, locale`
      )
      .bind(JSON.stringify(tokenHashes), nowISO, codeHash, LOGIN_CODE_MAX_ATTEMPTS)
      .first<{ donor_item_ids: string; locale: string | null }>();

    if (row === null) {
      return null;
    }

    return {
      donorItemIds: JSON.parse(row.donor_item_ids) as string[],
      locale: row.locale !== null && isLocale(row.locale) ? row.locale : null,
    };
  }
}
