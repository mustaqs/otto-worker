-- Wave 2 (SPEC.md A77): six more cloud apps, and two columns the connect
-- callback writes — `connected_at`, set once when a row first becomes active
-- so the header can list apps in connect order, and `defaults`, JSON the
-- callback looked up at connect time (the GitHub login, the GitLab and Jira
-- projects, the Linear user and teams), never at question time.
--
-- SQLite cannot widen a CHECK, so the table is rebuilt. Existing rows keep
-- their state; their `connected_at` is taken from `updated_at`, the best
-- record of when they connected, and their `defaults` are NULL until the
-- user reconnects the app — a tool that needs one asks for the detail.
CREATE TABLE IF NOT EXISTS integrations_v2 (
  account_id           TEXT NOT NULL REFERENCES accounts(id),
  app                  TEXT NOT NULL CHECK (app IN ('gmail', 'gcal', 'slack', 'github', 'gitlab', 'jira', 'gdrive', 'notion', 'linear')),
  connected_account_id TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN ('pending', 'active', 'expired')),
  updated_at           INTEGER NOT NULL,
  connected_at         INTEGER,
  defaults             TEXT,
  PRIMARY KEY (account_id, app)
);
INSERT INTO integrations_v2 (account_id, app, connected_account_id, state, updated_at, connected_at, defaults)
  SELECT account_id, app, connected_account_id, state, updated_at,
         CASE WHEN state = 'active' THEN updated_at ELSE NULL END, NULL
  FROM integrations;
DROP TABLE integrations;
ALTER TABLE integrations_v2 RENAME TO integrations;
CREATE INDEX IF NOT EXISTS integrations_by_connection ON integrations(connected_account_id);
