-- Branch 1: connected apps (SPEC.md A76).
--
-- One row per account per cloud app. `connected_account_id` is Composio's id
-- for the authorization; the authorization itself never lives here. `state`
-- is written by three things and read by two: the connect callback (active),
-- the expired-account webhook and a refused execute (expired), and unlink
-- (the row goes); read when the Integrations page opens and on every tool
-- reply. NOTHING ON THE QUESTION PATH READS THIS TABLE.
CREATE TABLE IF NOT EXISTS integrations (
  account_id           TEXT NOT NULL REFERENCES accounts(id),
  app                  TEXT NOT NULL CHECK (app IN ('gmail', 'gcal', 'slack')),
  connected_account_id TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN ('pending', 'active', 'expired')),
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (account_id, app)
);
CREATE INDEX IF NOT EXISTS integrations_by_connection ON integrations(connected_account_id);

-- Tool calls have their own cap, or they would silently spend question quota.
-- ZERO MEANS NO GATE, as it does for the other caps. Beta is unlimited; free is
-- twenty a day (A76 as approved). The trial has no account and cannot reach a
-- cloud tool at all, so its number is never read.
ALTER TABLE plans ADD COLUMN tool_cap INTEGER NOT NULL DEFAULT 0;
UPDATE plans SET tool_cap = 20 WHERE name = 'free';
UPDATE plans SET tool_cap = 0  WHERE name = 'beta';
