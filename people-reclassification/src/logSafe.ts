// Nothing this Worker logs may carry an email address or a person's name (the root README's
// Workers Issues note): log lines name Monday item ids and counts. Monday error bodies can quote
// an item, so error text is scrubbed before it is logged.
const EMAIL_PATTERN = /[^\s"'<>()[\]{},;:]+@[^\s"'<>()[\]{},;:]+\.[a-z]{2,}/gi;

export function redactEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, '<email redacted>');
}

export function errorText(err: unknown): string {
  return redactEmails(err instanceof Error ? err.message : String(err));
}
