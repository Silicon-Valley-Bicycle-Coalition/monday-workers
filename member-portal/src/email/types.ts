import type { Locale } from '../i18n/locales';

export interface SendLoginEmailParams {
  to: string;
  loginUrl: string;
  locale: Locale;
  // Browser-bound one-time code, shown in the email so Mail/Safari AutoFill can offer it.
  // Absent → the plain link-only email. `domain` is the portal's host, for the domain-bound
  // last line; `timeZone` is the requester's, for the expiry time.
  loginCode?: { code: string; expiresAt: string; timeZone: string; domain: string };
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

export interface EmailSender {
  sendLoginEmail(params: SendLoginEmailParams): Promise<void>;
  sendLetterReadyEmail(params: SendLetterReadyEmailParams): Promise<void>;
}
