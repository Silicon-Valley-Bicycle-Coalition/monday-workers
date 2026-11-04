-- One row per Monday OAuth app (portal / sync / readonly). Monday rotates the refresh token on
-- every refresh, so a refresher takes the lease (refresh_lease_*) at the version it read and
-- saves only if the version is unchanged and it still holds the lease (same scheme as
-- quickbooks-sync's qb_oauth_tokens, migration 0003).
CREATE TABLE oauth_tokens (
  app TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  authorized_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  version INTEGER NOT NULL DEFAULT 1,
  refresh_lease_token TEXT,
  refresh_lease_until TEXT,
  updated_at TEXT NOT NULL
);

-- In-flight consent flows: the PKCE verifier for a `state`, deleted when the callback reads it.
CREATE TABLE oauth_pending (
  state TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at TEXT NOT NULL
);
