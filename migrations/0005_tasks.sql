-- A82: long-running tasks. One row per task; the Workflow instance with the
-- same id is the engine and this row is the truth. NOTHING ON THE QUESTION
-- PATH READS THIS TABLE: the question reply learns of a task from the KV
-- summary `tasks:<account>`, which the Workflow and the task routes rewrite
-- from these rows after every transition (src/tasks/run.js, writeSummary).
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,                        -- the Workflow instance id, crypto.randomUUID()
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  type        TEXT NOT NULL,                           -- registry key: 'research'
  state       TEXT NOT NULL CHECK (state IN (
                'created', 'running', 'awaiting_approval', 'approved', 'declined',
                'succeeded', 'failed', 'cancelled', 'expired')),
  input       TEXT NOT NULL,                           -- JSON {request, context?, document?, now, tz, taskVersion}
  steps       TEXT NOT NULL DEFAULT '[]',              -- JSON [{name, started, ended, outcome, model?, in?, out?, cacheRead?, searches?, cents?}]
  question    TEXT,                                    -- JSON {spoken, askedAt, until}
  answer      TEXT,                                    -- JSON {decision, at}
  result      TEXT,                                    -- JSON {spoken, detail, deliver}   (detail <= 262,144 bytes)
  reason      TEXT,                                    -- one word: max_duration, step_failed, timeout, user, declined
  waited_ms   INTEGER NOT NULL DEFAULT 0,              -- time spent awaiting approval; subtracted from the max-duration clock
  seen_at     INTEGER,                                 -- set by /v1/tasks/take
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  finished_at INTEGER,                                 -- set on the first terminal state
  expires_at  INTEGER                                  -- finished_at + 7 days; a comparison at read deletes the row
);
CREATE INDEX IF NOT EXISTS tasks_by_account ON tasks(account_id, updated_at);

-- Tasks have their own daily cap, like tool calls (0003). ZERO MEANS NO GATE.
-- The trial has no account and never reaches a task. THE NUMBER FOR `free`
-- IS A PLACEHOLDER UNTIL SET: a task is tens of model calls, not one.
ALTER TABLE plans ADD COLUMN task_cap INTEGER NOT NULL DEFAULT 0;
UPDATE plans SET task_cap = 5 WHERE name = 'free';
UPDATE plans SET task_cap = 0 WHERE name = 'beta';
