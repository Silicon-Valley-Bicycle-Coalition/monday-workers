import { LOGIN_CODE_MAX_ATTEMPTS } from '../auth/loginCode';
import { isLocale, type Locale } from '../i18n/locales';

export interface NewMagicLinkToken {
  tokenHash: string;
  donorItemIds: string[];
  expiresAt: string;
  // Set only for an emailed link that also carries a login code; letter-ready rows omit them.
  requestHash?: string;
  codeHash?: string;
  locale?: Locale;
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

export class D1MagicLinkTokenStore implements MagicLinkTokenStore {
  constructor(private db: D1Database) {}

  async createToken(params: NewMagicLinkToken): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO magic_link_tokens (token_hash, donor_item_ids, expires_at, request_hash, code_hash, locale)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      )
      .bind(
        params.tokenHash,
        JSON.stringify(params.donorItemIds),
        params.expiresAt,
        params.requestHash ?? null,
        params.codeHash ?? null,
        params.locale ?? null
      )
      .run();
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

  // Every check counts against each live row of the request, right code or wrong, before the
  // match is tried, so at most LOGIN_CODE_MAX_ATTEMPTS checks can ever reach the second
  // statement, even when they race. Using the code burns the row's link too (used_at).
  async consumeCode(requestHash: string, codeHash: string, nowISO: string): Promise<ConsumedCode | null> {
    const counted = await this.db
      .prepare(
        `UPDATE magic_link_tokens SET code_attempts = code_attempts + 1
         WHERE request_hash = ?1 AND used_at IS NULL AND expires_at > ?2 AND code_attempts < ?3`
      )
      .bind(requestHash, nowISO, LOGIN_CODE_MAX_ATTEMPTS)
      .run();

    if (counted.meta.changes === 0) {
      return null;
    }

    const row = await this.db
      .prepare(
        `UPDATE magic_link_tokens SET used_at = ?2
         WHERE request_hash = ?1 AND code_hash = ?3 AND used_at IS NULL AND expires_at > ?2
           AND code_attempts <= ?4
         RETURNING donor_item_ids, locale`
      )
      .bind(requestHash, nowISO, codeHash, LOGIN_CODE_MAX_ATTEMPTS)
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
