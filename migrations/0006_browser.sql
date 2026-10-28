-- A89: browser tasks. A browser step's model call goes through
-- /v1/tasks/ask, never /v1/ask, and is counted twice: on the task's row,
-- atomically, against BROWSER_MAX_CALLS (src/tasks/registry.js), and on the
-- account's day against the plan's step_cap. NEITHER IS ON THE QUESTION PATH:
-- /v1/ask still reads one KV record and the question counters, and nothing
-- here is read there.
ALTER TABLE tasks ADD COLUMN calls INTEGER NOT NULL DEFAULT 0;

-- Browser steps have their own daily cap, like tools and tasks. ZERO MEANS NO
-- GATE. /v1/tasks/ask reads this column alone and REFUSES when the row or the
-- column is missing, so a deploy before this migration fails closed.
ALTER TABLE plans ADD COLUMN step_cap INTEGER NOT NULL DEFAULT 0;
UPDATE plans SET step_cap = 100 WHERE name = 'free';
UPDATE plans SET step_cap = 0 WHERE name = 'beta';
