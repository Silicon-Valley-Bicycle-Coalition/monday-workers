import { escapeHtml } from './escapeHtml';

// Wraps the EMAIL send binding in the sandbox environment so that no message can leave for a
// real staff member: every recipient is replaced with the sink address and the original recipient
// is preserved in the subject, a body notice, and a header for whoever reads the sandbox inbox.
// Copied from bp-feedback-notify/src/email/sandboxBinding.ts (itself from
// member-portal/src/email/sandboxBinding.ts) — same shape, same invariant. See member-portal's
// comment for why this is a code-layer belt to wrangler.jsonc's platform-layer suspenders
// (env.sandbox.send_email[0].allowed_destination_addresses); config/split.test.ts checks both
// name the same address.

export const SANDBOX_ORIGINAL_RECIPIENT_HEADER = 'X-SVBC-Sandbox-Original-To';

type Recipients = EmailMessageBuilder['to'];

function isBuilder(message: EmailMessage | EmailMessageBuilder): message is EmailMessageBuilder {
  return typeof (message as Partial<EmailMessageBuilder>).subject === 'string';
}

function addressesOf(value: Recipients | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => (typeof entry === 'string' ? entry : entry.email));
}

export function sandboxEmailBinding(inner: SendEmail, sink: string): SendEmail {
  return {
    async send(message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> {
      if (!isBuilder(message)) {
        throw new Error('sandbox email binding: raw EmailMessage sends are not supported; use the builder form');
      }

      const originalRecipients = [...addressesOf(message.to), ...addressesOf(message.cc), ...addressesOf(message.bcc)];
      const originalTo = originalRecipients.join(', ');
      const notice = `Sandbox copy. Production would have sent this to ${originalTo}.`;

      // Count only: the addresses stay in the sink copy's subject and header, out of Workers Logs.
      // email-log drops bp-feedback-notify's `subject` field here: this Worker's subjects are staff
      // email subjects, which must never reach a log line.
      console.log(JSON.stringify({ sandboxOutbound: 'email', recipients: originalRecipients.length }));

      const { cc: _cc, bcc: _bcc, replyTo: _replyTo, ...rest } = message;
      return inner.send({
        ...rest,
        to: sink,
        subject: `[sandbox → ${originalTo}] ${message.subject}`,
        text: message.text === undefined ? undefined : `${notice}\n\n${message.text}`,
        html: message.html === undefined ? undefined : `<p><strong>${escapeHtml(notice)}</strong></p>${message.html}`,
        headers: { ...(message.headers ?? {}), [SANDBOX_ORIGINAL_RECIPIENT_HEADER]: originalTo },
      });
    },
  };
}
