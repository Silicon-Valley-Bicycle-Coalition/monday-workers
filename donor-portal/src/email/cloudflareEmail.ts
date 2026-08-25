import { escapeHtml } from '../views';
import { t } from '../i18n/t';
import type { EmailSender, SendLoginEmailParams, SendLetterReadyEmailParams } from './types';

export class CloudflareEmailSender implements EmailSender {
  constructor(
    private emailBinding: SendEmail,
    private fromAddress: string,
    private fromName: string
  ) {}

  async sendLoginEmail(params: SendLoginEmailParams): Promise<void> {
    const subject = t(params.locale, 'email.subject');
    const bodyIntro = t(params.locale, 'email.bodyIntro');
    const loginButton = t(params.locale, 'email.loginButton');
    await this.emailBinding.send({
      to: params.to,
      from: { email: this.fromAddress, name: this.fromName },
      subject,
      html: `<p>${bodyIntro}</p><p><a href="${params.loginUrl}">${loginButton}</a></p>`,
      text: `${bodyIntro}\n\n${params.loginUrl}`,
    });
  }

  // Not yet localized — this template shipped on main while the i18n work was in progress and
  // isn't part of the translated key set (src/i18n/locales/*.ts). Follow-up: add
  // letterReady.* keys across all locales and thread a `locale` param through the same way
  // sendLoginEmail does, mirroring requestLogin's Monday-preference resolution.
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
