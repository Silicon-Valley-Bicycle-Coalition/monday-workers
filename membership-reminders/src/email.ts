import type { RenderedEmail } from './templates';

export interface EmailRecipient {
  email: string;
  name: string;
}

export type SendReminderEmail = (recipient: EmailRecipient, email: RenderedEmail) => Promise<void>;

export function createEmailSender(emailBinding: SendEmail, fromAddress: string, fromName: string): SendReminderEmail {
  return async (recipient, email) => {
    await emailBinding.send({
      to: recipient.email,
      from: { email: fromAddress, name: fromName },
      subject: email.subject,
      text: email.body,
    });
  };
}
