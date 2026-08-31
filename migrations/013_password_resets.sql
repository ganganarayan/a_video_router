-- Self-serve password reset (email link). Tokens are single-use, 1-hour expiry.
-- Only the SHA-256 hash of the token is stored, never the raw token.
CREATE TABLE IF NOT EXISTS password_resets (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_token_idx ON password_resets (token_hash);
CREATE INDEX IF NOT EXISTS password_resets_email_idx ON password_resets (email, created_at DESC);
