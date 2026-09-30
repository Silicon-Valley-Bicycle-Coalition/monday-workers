import type { EmailSender, SendLetterReadyEmailParams, SendLoginEmailParams } from './types';

// Local-preview-only EmailSender (see src/index.local.ts) — prints the link instead of sending
// mail, since local dev has no Cloudflare Email Sending domain onboarded. Copy the printed URL
// into the browser to complete login or open a letter-ready link.
export class ConsoleEmailSender implements EmailSender {
  async sendLoginEmail(params: SendLoginEmailParams): Promise<void> {
    // log-safety: allow — local-only (index.local.ts), never deployed; printing the address and link is the point.
    console.log(`\n[dev email] Login link for ${params.to} (${params.locale}):\n  ${params.loginUrl}\n`);
  }

  async sendLetterReadyEmail(params: SendLetterReadyEmailParams): Promise<void> {
    // log-safety: allow — local-only (index.local.ts), never deployed; printing the address and link is the point.
    console.log(
      `\n[dev email] "Your ${params.year} letter is ready" for ${params.donorName} <${params.to}>:\n  ${params.loginUrl}\n`
    );
  }
}
