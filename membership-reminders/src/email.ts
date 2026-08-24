import type { RenderedEmail } from './templates';

export interface EmailRecipient {
  email: string;
  name: string;
}

export async function sendReminderEmail(
  recipient: EmailRecipient,
  email: RenderedEmail,
): Promise<void> {
  console.log(
    `[email-stub] would send to ${recipient.email} (${recipient.name}): subject="${email.subject}"`,
  );
}
