/** What a message's dedupe hash is derived from: its Message-ID, or (from, date, subject) when it has none. */
export type DedupeSource = { messageId: string } | { from: string; dateISO: string; subject: string };

// Trim, drop one pair of angle brackets, and lowercase only the host part: the local part of a
// Message-ID is case-sensitive, the domain is not.
function normalizeMessageId(raw: string): string {
  let id = raw.trim();
  if (id.startsWith('<') && id.endsWith('>')) id = id.slice(1, -1).trim();
  const at = id.lastIndexOf('@');
  return at === -1 ? id : id.slice(0, at + 1) + id.slice(at + 1).toLowerCase();
}

/**
 * Hex SHA-256 of the message's identity. The input is domain-separated ("mid:" / "fb:") so a
 * Message-ID can never collide with a fallback. An empty Message-ID is treated as absent and
 * throws; callers pass the (from, date, subject) fallback instead.
 */
export async function messageIdHash(source: DedupeSource): Promise<string> {
  let input: string;
  if ('messageId' in source) {
    const id = normalizeMessageId(source.messageId);
    if (id === '') throw new TypeError('Message-ID is empty; use the from/date/subject fallback');
    input = `mid:${id}`;
  } else {
    input = `fb:${JSON.stringify([source.from.toLowerCase(), source.dateISO, source.subject])}`;
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
