import type { MondayClient } from '../monday/client';
import type { Config } from '../types';
import { resolveOrgGrants, type OrgGrant } from '../orgs/grants';
import { errorText } from '../logSafe';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/types';
import { sha256Hex } from '../crypto/hash';
import { generateToken } from '../crypto/token';
import { generateCode } from '../crypto/code';
import { magicLinkUrl } from './magicLinkUrl';
import { localeFromMondayLabel, type Locale } from '../i18n/locales';

export interface RequestLoginDeps {
  monday: MondayClient;
  config: Config;
  tokenStore: MagicLinkTokenStore;
  emailSender: EmailSender;
  portalBaseUrl: string;
  magicLinkTtlMinutes: number;
  now: () => Date;
}

// `next`: the portal page the donor was headed to (routes.ts validates it), carried in the link.
export async function requestLogin(email: string, localeHint: Locale, requestId: string, deps: RequestLoginDeps, next: string | null = null): Promise<void> {
  const matches = await deps.monday.findDonorsByEmail(email);
  // Organizations the address may act for (orgs/grants.ts). resolveOrgGrants guards its own reads;
  // this catch is the backstop so a person always signs in for their own records.
  let orgGrants: OrgGrant[] = [];
  try {
    orgGrants = await resolveOrgGrants(email, matches, { monday: deps.monday, config: deps.config });
  } catch (err) {
    console.error(`member-portal org grants failed at sign-in: ${errorText(err)}`);
  }
  // Nothing matched: no email. The route answers the same either way (enumeration guard).
  if (matches.length === 0 && orgGrants.length === 0) {
    return;
  }

  // First match's stored preference wins when a shared email matches multiple donor records with
  // different languages on file — a documented default (spec), not expected to come up often.
  // localeFromMondayLabel returns null for '' (unset) and for any value that isn't one of the
  // Monday dropdown's own options, so both cases fall through to localeHint identically. A Work
  // Email sign-in has no people, so it takes localeHint (the rep's person isn't read for this).
  const locale: Locale = (matches[0] ? localeFromMondayLabel(matches[0].preferredLanguage) : null) ?? localeHint;

  const rawToken = generateToken();
  const tokenHash = await sha256Hex(rawToken);
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + deps.magicLinkTtlMinutes * 60_000).toISOString();

  // One row per request carries both the link's token hash and the code's hash. The code is bound
  // to the request id (which only the browser that asked holds), so it is useless without it.
  const code = generateCode();
  await deps.tokenStore.createToken({
    tokenHash,
    donorItemIds: matches.map((match) => match.id),
    orgGrants,
    expiresAt,
    requestHash: await sha256Hex(requestId),
    codeHash: await sha256Hex(`${requestId}:${code}`),
    emailHash: await sha256Hex(email),
  });

  const loginUrl = magicLinkUrl(deps.portalBaseUrl, rawToken, locale, next);
  await deps.emailSender.sendLoginEmail({ to: email, loginUrl, code, ttlMinutes: deps.magicLinkTtlMinutes, locale });
}
