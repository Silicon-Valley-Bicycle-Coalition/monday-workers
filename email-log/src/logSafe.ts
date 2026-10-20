// Copied from people-reclassification/src/logSafe.ts. Nothing this Worker logs or stores in D1
// may carry an email address, subject or body (the root README's Workers Issues note): log lines
// carry the 12-hex-char hash prefix. Monday error bodies can quote an item, so error text is
// scrubbed of addresses before it is logged or recorded.
const EMAIL_PATTERN = /[^\s"'<>()[\]{},;:]+@[^\s"'<>()[\]{},;:]+\.[a-z]{2,}/gi;

export function redactEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, '<email redacted>');
}

export function errorText(err: unknown): string {
  return redactEmails(err instanceof Error ? err.message : String(err));
}
