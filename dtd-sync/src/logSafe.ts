// Same pattern as flags.ts's EMAIL_PATTERN and scripts/check-log-safety.mjs's redactEmails.
const EMAIL_PATTERN = /[^\s"'<>()[\]{},;:]+@[^\s"'<>()[\]{},;:]+\.[a-z]{2,}/gi;
const MAX_LENGTH = 300;

/** `text` with email-shaped substrings replaced by `[email]`, cut to 300 characters. */
export function redactText(text: string): string {
  const scrubbed = text.replace(EMAIL_PATTERN, '[email]');
  return scrubbed.length > MAX_LENGTH ? `${scrubbed.slice(0, MAX_LENGTH)}…` : scrubbed;
}

/** One line for a per-item job failure: `dtd-sync: <job> item <id> failed <scrubbed message>`. */
export function logItemFailure(job: string, id: string, err: unknown): void {
  console.log(`dtd-sync: ${job} item ${id} failed ${err instanceof Error ? redactText(err.message) : 'unknown error'}`);
}
