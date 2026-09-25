-- Single-refresher lease and compare-and-swap for the OAuth token row (#33). Intuit rotates the
-- refresh token and expires the previous one, so two writers refreshing at once could leave D1
-- holding a token Intuit has already invalidated — every later call then fails until the pair is
-- re-seeded by hand. A refresher must now take the lease (refresh_lease_token/_until) at the
-- version it read, and saves only if the version is unchanged and it still holds the lease; each
-- save bumps version. Additive: existing rows get version 0 and no lease.
ALTER TABLE qb_oauth_tokens ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE qb_oauth_tokens ADD COLUMN refresh_lease_token TEXT;
ALTER TABLE qb_oauth_tokens ADD COLUMN refresh_lease_until TEXT;
