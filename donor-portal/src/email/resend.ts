export interface SendLoginEmailParams {
  to: string;
  loginUrl: string;
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
        subject: 'Your SVBC donor portal login link',
        html: `<p>Click below to log in to the donor portal. This link expires soon and can only be used once.</p><p><a href="${params.loginUrl}">Log in</a></p>`,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`resend: HTTP ${response.status}: ${body}`);
    }
  }
}
