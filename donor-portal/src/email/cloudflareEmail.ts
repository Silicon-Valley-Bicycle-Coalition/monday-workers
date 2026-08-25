import { escapeHtml } from '../views';
import type { EmailSender, SendLoginEmailParams, SendLetterReadyEmailParams } from './types';

export class CloudflareEmailSender implements EmailSender {
  constructor(
    private emailBinding: SendEmail,
    private fromAddress: string,
    private fromName: string
  ) {}

  async sendLoginEmail(params: SendLoginEmailParams): Promise<void> {
    await this.emailBinding.send({
      to: params.to,
      from: { email: this.fromAddress, name: this.fromName },
      subject: 'Your SVBC donor portal login link',
      html: `<p>Click below to log in to the donor portal. This link expires soon and can only be used once.</p><p><a href="${params.loginUrl}">Log in</a></p>`,
      text: `Log in to the donor portal. This link expires soon and can only be used once.\n\n${params.loginUrl}`,
    });
  }

  async sendLetterReadyEmail(params: SendLetterReadyEmailParams): Promise<void> {
    const donorName = escapeHtml(params.donorName);
    await this.emailBinding.send({
      to: params.to,
      from: { email: this.fromAddress, name: this.fromName },
      subject: `Your ${params.year} SVBC giving letter is ready`,
      html: `<p>Hi ${donorName},</p><p>Your ${params.year} giving letter is ready to view in your donor portal.</p><p><a href="${params.loginUrl}">Log in to view it</a></p><p>This link expires soon and can only be used once.</p>`,
      text: `Hi ${params.donorName},\n\nYour ${params.year} giving letter is ready to view in your donor portal. This link expires soon and can only be used once.\n\n${params.loginUrl}`,
    });
  }
}
