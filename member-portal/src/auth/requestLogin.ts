import type { MondayClient } from '../monday/client';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/types';
import { sha256Hex } from '../crypto/hash';
import { generateToken } from '../crypto/token';
import { magicLinkUrl } from './magicLinkUrl';
import { localeFromMondayLabel, type Locale } from '../i18n/locales';

export interface RequestLoginDeps {
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  emailSender: EmailSender;
  portalBaseUrl: string;
  magicLinkTtlMinutes: number;
  now: () => Date;
}

export async function requestLogin(email: string, localeHint: Locale, deps: RequestLoginDeps): Promise<void> {
  const matches = await deps.monday.findDonorsByEmail(email);
  if (matches.length === 0) {
    return;
  }

  // First match's stored preference wins when a shared email matches multiple donor records with
  // different languages on file — a documented default (spec), not expected to come up often.
  // localeFromMondayLabel returns null for '' (unset) and for any value that isn't one of the
  // Monday dropdown's own options, so both cases fall through to localeHint identically.
  const locale: Locale = localeFromMondayLabel(matches[0]!.preferredLanguage) ?? localeHint;

  const rawToken = generateToken();
  const tokenHash = await sha256Hex(rawToken);
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + deps.magicLinkTtlMinutes * 60_000).toISOString();

  await deps.tokenStore.createToken({
    tokenHash,
    donorItemIds: matches.map((match) => match.id),
    expiresAt,
  });

  const loginUrl = magicLinkUrl(deps.portalBaseUrl, rawToken, locale);
  await deps.emailSender.sendLoginEmail({ to: email, loginUrl, locale });
}
