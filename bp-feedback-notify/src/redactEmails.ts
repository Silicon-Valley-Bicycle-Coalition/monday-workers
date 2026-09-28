const EMAIL_IN_TEXT = /[^\s@<>"'(),;:[\]]+@[^\s@<>"'(),;:[\]]+\.[^\s@<>"'(),;:[\]]+/g;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Strips email addresses out of an error message before it's logged — send_email's errors can
 * quote the destination (e.g. "destination address <x> is not verified"), and Worker logs are no
 * place for organizers' addresses. The known recipient addresses are removed verbatim
 * (case-insensitively) first, so even an address the pattern below wouldn't recognize is caught;
 * then anything else address-shaped.
 */
export function redactEmails(message: string, known: string[]): string {
  let redacted = message;
  for (const address of known) {
    if (address) redacted = redacted.replace(new RegExp(escapeRegExp(address), 'gi'), '[redacted]');
  }
  return redacted.replace(EMAIL_IN_TEXT, '[redacted]');
}
