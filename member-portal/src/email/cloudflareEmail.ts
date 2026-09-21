import { escapeHtml } from '../views';
import { t } from '../i18n/t';
import { renderLetterEmailBody } from '../letters/letterEmailBody';
import { renderEmailLayout } from './layout';
import type { EmailSender, SendLoginEmailParams, SendLetterReadyEmailParams } from './types';

export class CloudflareEmailSender implements EmailSender {
  constructor(
    private emailBinding: SendEmail,
    private fromAddress: string,
    private fromName: string,
    private logoUrl: string,
    private replyTo?: string
  ) {}

  async sendLoginEmail(params: SendLoginEmailParams): Promise<void> {
    const subject = `🚴 ${t(params.locale, 'email.subject')}`;
    const bodyIntro = t(params.locale, 'email.bodyIntro');
    const loginButton = t(params.locale, 'email.loginButton');
    const body = renderEmailLayout({
      bodyHtml: `<p>${bodyIntro}</p><p><a href="${params.loginUrl}">${loginButton}</a></p>`,
      bodyText: `${bodyIntro}\n\n${params.loginUrl}`,
      logoUrl: this.logoUrl,
    });
    await this.emailBinding.send({
      to: params.to,
      from: { email: this.fromAddress, name: this.fromName },
      ...(this.replyTo ? { replyTo: this.replyTo } : {}),
      subject,
      html: body.html,
      text: body.text,
    });
  }

  async sendLetterReadyEmail(params: SendLetterReadyEmailParams): Promise<void> {
    const template = params.bodyTemplate?.trim();
    const rendered = template
      ? renderLetterEmailBody(template, { donorName: params.donorName, year: params.year, loginUrl: params.loginUrl })
      : this.defaultLetterReadyBody(params);
    const body = renderEmailLayout({ bodyHtml: rendered.html, bodyText: rendered.text, logoUrl: this.logoUrl });
    await this.emailBinding.send({
      to: params.to,
      from: { email: this.fromAddress, name: this.fromName },
      ...(this.replyTo ? { replyTo: this.replyTo } : {}),
      // Subject is always ours, so it always follows the donor's locale — even when the body
      // comes from a staff template.
      subject: `🚴 ${t(params.locale, 'letterReady.subject', { year: String(params.year) })}`,
      html: body.html,
      text: body.text,
    });
  }

  private defaultLetterReadyBody(params: SendLetterReadyEmailParams): { html: string; text: string } {
    const year = String(params.year);
    const greeting = t(params.locale, 'letterReady.greeting', { donorName: params.donorName });
    const bodyLine = t(params.locale, 'letterReady.body', { year });
    const loginLink = t(params.locale, 'letterReady.loginLink');
    const expiry = t(params.locale, 'letterReady.expiry');
    const greetingHtml = t(params.locale, 'letterReady.greeting', { donorName: escapeHtml(params.donorName) });
    return {
      html: `<p>${greetingHtml}</p><p>${bodyLine}</p><p><a href="${params.loginUrl}">${loginLink}</a></p><p>${expiry}</p>`,
      text: `${greeting}\n\n${bodyLine} ${expiry}\n\n${params.loginUrl}`,
    };
  }
}
