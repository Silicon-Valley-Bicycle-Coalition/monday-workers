// Wrong sign-in code guesses per address. Kept apart from magic_link_tokens, whose rows are purged
// once expired (15 minutes in) — that would reset a 24-hour count. Slots are reserved by
// MagicLinkTokenStore.takeCodeAttempt, in the same transaction that counts the try.
export interface CodeFailureStore {
  // Gives a reserved slot back (the guess turned out right).
  releaseFailure(id: number): Promise<void>;
}

export class D1CodeFailureStore implements CodeFailureStore {
  constructor(private db: D1Database) {}

  async releaseFailure(id: number): Promise<void> {
    await this.db.prepare('DELETE FROM code_failures WHERE id = ?1').bind(id).run();
  }
}
