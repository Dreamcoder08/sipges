-- Identity & Access (docs/adr/0004). Global tables: not tenant-scoped, no RLS.

CREATE TABLE users (
  -- New accounts are validated by the domain; imported legacy names only need sane bounds.
  username           text PRIMARY KEY CHECK (char_length(username) BETWEEN 1 AND 120),
  full_name          text NOT NULL,
  password_hash      text NOT NULL,
  role               text NOT NULL CHECK (role IN ('admin', 'analista', 'coordinador', 'consulta')),
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  totp_secret_sealed text,
  totp_enabled       boolean NOT NULL DEFAULT false,
  totp_last_step     bigint
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  username   text NOT NULL REFERENCES users (username) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_username_idx ON sessions (username);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Failed login attempts for throttling; subject is 'user:<name>' or 'ip:<address>'.
CREATE TABLE login_failures (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject   text NOT NULL,
  failed_at timestamptz NOT NULL
);
CREATE INDEX login_failures_subject_idx ON login_failures (subject, failed_at);
