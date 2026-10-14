-- Sign in with Google (docs/adr/0010-google-sign-in.md).
-- An administrator links one verified Google address to one existing account; nobody is
-- created on first sign-in. Sessions remember that Google, not the password, opened them.

ALTER TABLE users ADD COLUMN google_email text
  CHECK (google_email IS NULL OR (google_email = lower(google_email)
    AND char_length(google_email) BETWEEN 3 AND 254));
CREATE UNIQUE INDEX users_google_email_key ON users (google_email) WHERE google_email IS NOT NULL;

ALTER TABLE sessions ADD COLUMN via_google boolean NOT NULL DEFAULT false;
