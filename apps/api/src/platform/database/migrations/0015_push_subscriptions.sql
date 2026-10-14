-- Browser push subscriptions (docs/adr/0014 §5). Global like sessions: a subscription belongs to
-- a person and a device, and pushes reach it for every project the person is granted.

CREATE TABLE push_subscriptions (
  endpoint   text PRIMARY KEY CHECK (endpoint ~ '^https://' AND char_length(endpoint) <= 1000),
  username   text NOT NULL REFERENCES users (username) ON DELETE CASCADE,
  p256dh     text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth       text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  created_at timestamptz NOT NULL
);
CREATE INDEX push_subscriptions_username ON push_subscriptions (username);
