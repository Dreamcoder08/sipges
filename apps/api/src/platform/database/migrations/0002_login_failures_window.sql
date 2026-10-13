-- Expired throttling rows are purged by failed_at alone (reserveLoginAttempt).
CREATE INDEX login_failures_failed_at_idx ON login_failures (failed_at);
