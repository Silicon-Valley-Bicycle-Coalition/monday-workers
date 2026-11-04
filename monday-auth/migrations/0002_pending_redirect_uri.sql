-- The redirect_uri sent at /oauth/start, replayed verbatim at the token exchange (Monday requires
-- the two to match, and the callback may arrive on a different host than the start request).
-- Rows from before this migration are short-lived (10 minute TTL) and fail the exchange harmlessly.
ALTER TABLE oauth_pending ADD COLUMN redirect_uri TEXT NOT NULL DEFAULT '';
