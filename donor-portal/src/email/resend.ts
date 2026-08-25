import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';

export interface SendLoginEmailParams {
  to: string;
  loginUrl: string;
  locale: Locale;
}

export interface EmailSender {
  sendLoginEmail(params: SendLoginEmailParams): Promise<void>;
}

export class ResendEmailSender implements EmailSender {
  constructor(
    private apiKey: string,
    private fromAddress: string,
    private fromName: string,
    private fetchFn: typeof fetch = fetch
  ) {}

  async sendLoginEmail(params: SendLoginEmailParams): Promise<void> {
    const response = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: `${this.fromName} <${this.fromAddress}>`,
        to: [params.to],
        subject: t(params.locale, 'email.subject'),
        html: `<p>${t(params.locale, 'email.bodyIntro')}</p><p><a href="${params.loginUrl}">${t(params.locale, 'email.loginButton')}</a></p>`,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`resend: HTTP ${response.status}: ${body}`);
    }
  }
}
