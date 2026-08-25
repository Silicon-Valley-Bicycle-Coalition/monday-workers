import { escapeHtml } from '../views';

export interface SendLoginEmailParams {
  to: string;
  loginUrl: string;
}

export interface SendLetterReadyEmailParams {
  to: string;
  donorName: string;
  year: number;
  loginUrl: string;
}

export interface EmailSender {
  sendLoginEmail(params: SendLoginEmailParams): Promise<void>;
  sendLetterReadyEmail(params: SendLetterReadyEmailParams): Promise<void>;
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
        subject: 'Your SVBC donor portal login link',
        html: `<p>Click below to log in to the donor portal. This link expires soon and can only be used once.</p><p><a href="${params.loginUrl}">Log in</a></p>`,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`resend: HTTP ${response.status}: ${body}`);
    }
  }

  async sendLetterReadyEmail(params: SendLetterReadyEmailParams): Promise<void> {
    const response = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: `${this.fromName} <${this.fromAddress}>`,
        to: [params.to],
        subject: `Your ${params.year} SVBC giving letter is ready`,
        html: `<p>Hi ${escapeHtml(params.donorName)},</p><p>Your ${params.year} giving letter is ready to view in your donor portal.</p><p><a href="${params.loginUrl}">Log in to view it</a></p><p>This link expires soon and can only be used once.</p>`,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`resend: HTTP ${response.status}: ${body}`);
    }
  }
}
