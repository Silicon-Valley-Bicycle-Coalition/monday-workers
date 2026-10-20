/** What a message's dedupe hash is derived from: its Message-ID, or (from, date, subject) when it has none. */
export type DedupeSource = { messageId: string } | { from: string; dateISO: string; subject: string };
