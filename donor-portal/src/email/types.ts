import type { Locale } from '../i18n/locales';

export interface SendLoginEmailParams {
  to: string;
  loginUrl: string;
  locale: Locale;
}

export interface SendLetterReadyEmailParams {
  to: string;
  donorName: string;
  year: number;
  loginUrl: string;
  // Staff-edited plain-text template from the Letter Settings board (see
  // src/letters/letterEmailBody.ts for the placeholder contract). Blank/absent → built-in copy.
  bodyTemplate?: string;
}

export interface EmailSender {
  sendLoginEmail(params: SendLoginEmailParams): Promise<void>;
  sendLetterReadyEmail(params: SendLetterReadyEmailParams): Promise<void>;
}
