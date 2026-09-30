import md5 from 'md5';

// Nothing this Worker logs may carry an email address: Workers Issues forwards the logs around
// a failure to whatever its automations target (see the root README). Inbound rows are keyed by
// address, so logs name the Mailchimp member id instead — the MD5 of the lowercased address,
// the same subscriber hash the Mailchimp API and UI use, so a log line still leads to the member.

export function memberId(email: string): string {
  return md5(email.trim().toLowerCase());
}

// Mailchimp error bodies quote the address (e.g. "a@b.com is already a list member"), and they
// ride along in err.message — so error text is scrubbed too, not just the line's subject.
const EMAIL_PATTERN = /[^\s"'<>()[\]{},;:]+@[^\s"'<>()[\]{},;:]+\.[a-z]{2,}/gi;

export function redactEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, (email) => `<member ${memberId(email)}>`);
}

export function errorText(err: unknown): string {
  return redactEmails(err instanceof Error ? err.message : String(err));
}
