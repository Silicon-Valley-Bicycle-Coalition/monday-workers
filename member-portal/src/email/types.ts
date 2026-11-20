import type { Locale } from '../i18n/locales';

export interface SendLoginEmailParams {
  to: string;
  loginUrl: string;
  // The 6-digit sign-in code, shown before the link.
  code: string;
  // How long the link and code last, for the email's expiry line.
  ttlMinutes: number;
  // The portal's host (member.bikesiliconvalley.org), for the "@host #code" line that lets Apple
  // AutoFill offer the code on that site only.
  domain: string;
  locale: Locale;
}

export interface SendLetterReadyEmailParams {
  to: string;
  donorName: string;
  year: number;
  loginUrl: string;
  // The donor's preferred locale (Monday Preferred Language column, default 'en'). Localizes the
  // subject always, and the body whenever the built-in copy is used.
  locale: Locale;
  // Staff-edited plain-text template from the Letter Settings board (see
  // src/letters/letterEmailBody.ts for the placeholder contract) — already resolved to the
  // donor's locale by the caller. Blank/absent → localized built-in copy.
  bodyTemplate?: string;
  // Absolute URL of the portal's Employer field (issue GL#127), set only while
  // employerAnswerEnabled(config). Present → one line after the body asks where the donor
  // works; absent → no line.
  employerUrl?: string;
}

// The January email to an organization rep (src/orgs/processOrgStatementSend.ts). Built-in i18n
// copy only: the Letter Settings templates are written to a donor about their own letter.
export interface SendOrgStatementReadyEmailParams {
  to: string;
  orgName: string;
  year: number;
  // The sign-in link, landing on the organization's statement for the year.
  loginUrl: string;
  locale: Locale;
}

export interface EmailSender {
  sendLoginEmail(params: SendLoginEmailParams): Promise<void>;
  sendLetterReadyEmail(params: SendLetterReadyEmailParams): Promise<void>;
  sendOrgStatementReadyEmail(params: SendOrgStatementReadyEmailParams): Promise<void>;
}
