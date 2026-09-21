import { escapeHtml } from './escapeHtml';
import type { EmailSender, SendFeedbackRequestEmailParams } from './types';

export class CloudflareEmailSender implements EmailSender {
  constructor(
    private emailBinding: SendEmail,
    private fromAddress: string,
    private fromName: string
  ) {}

  async sendFeedbackRequestEmail(params: SendFeedbackRequestEmailParams): Promise<void> {
    const subject = `How did SVBC's Bike Valet do at ${params.eventName}?`;
    const html = `<p>Thanks for hosting SVBC's Bike Valet at ${escapeHtml(params.eventName)}! We'd love to hear how it went — it only takes a couple of minutes:</p><p><a href="${params.feedbackFormUrl}">${params.feedbackFormUrl}</a></p>`;
    const text = `Thanks for hosting SVBC's Bike Valet at ${params.eventName}! We'd love to hear how it went — it only takes a couple of minutes:\n\n${params.feedbackFormUrl}`;
    await this.emailBinding.send({
      to: params.to,
      from: { email: this.fromAddress, name: this.fromName },
      subject,
      html,
      text,
    });
  }
}
