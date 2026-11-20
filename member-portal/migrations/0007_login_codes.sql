-- A one-time login code in the login email, checked only from the browser that asked for it
-- (src/auth/loginCode.ts). The code and the link share one row, so using either burns both.
-- request_hash binds checks to that browser's request id; code_hash is hashLoginCode(requestId,
-- code); code_attempts caps checks at LOGIN_CODE_MAX_ATTEMPTS across every row of a request;
-- locale is the language the login was asked for in. Letter-ready rows leave them null.
-- Additive only.
ALTER TABLE magic_link_tokens ADD COLUMN request_hash TEXT;
ALTER TABLE magic_link_tokens ADD COLUMN code_hash TEXT;
ALTER TABLE magic_link_tokens ADD COLUMN code_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE magic_link_tokens ADD COLUMN locale TEXT;
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_request_hash ON magic_link_tokens (request_hash);
