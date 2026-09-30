// Nothing this Worker logs may carry an email address: Workers Issues forwards the logs around
// a failure to whatever its automations target (see the root README). Log lines name the donor's
// Monday item id instead; error text from an email send or a lookup by address can still quote
// the address, so it is scrubbed before it is logged.
const EMAIL_PATTERN = /[^\s"'<>()[\]{},;:]+@[^\s"'<>()[\]{},;:]+\.[a-z]{2,}/gi;

export function redactEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, '<email>');
}

export function errorText(err: unknown): string {
  return redactEmails(err instanceof Error ? err.message : String(err));
}
