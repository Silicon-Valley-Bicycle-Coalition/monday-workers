import { escapeHtml } from '../views';

// Wraps the EMAIL send binding in the sandbox environment so that no message can leave for a
// donor: every recipient is replaced with the sink address and the original recipient is
// preserved in the subject, a body notice, and a header for whoever reads the sandbox inbox.
//
// This is the *code* layer. The *platform* layer is wrangler.jsonc's
// env.sandbox.send_email[0].allowed_destination_addresses, which makes Cloudflare reject any
// other recipient with E_RECIPIENT_NOT_ALLOWED even if this wrapper were removed. Both must
// name the same address — config/split.test.ts checks that.
//
// Wraps the binding rather than EmailSender because the subject is composed inside
// CloudflareEmailSender; only the binding sees the final message.

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
        // A raw MIME message can carry recipients in its own headers that this wrapper cannot
        // see, so it is refused outright. The portal only ever sends the builder form.
        throw new Error('sandbox email binding: raw EmailMessage sends are not supported; use the builder form');
      }

      const originalRecipients = [...addressesOf(message.to), ...addressesOf(message.cc), ...addressesOf(message.bcc)];
      const originalTo = originalRecipients.join(', ');
      const notice = `Sandbox copy. Production would have sent this to ${originalTo}.`;

      // Count only: the addresses stay in the sink copy's subject and header, out of Workers Logs.
      console.log(JSON.stringify({ sandboxOutbound: 'email', recipients: originalRecipients.length, subject: message.subject }));

      // cc/bcc/replyTo are dropped, not rewritten: one copy to the sink is the whole point, and a
      // replyTo pointing at the donor would let a human reply from the sandbox inbox reach them.
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
