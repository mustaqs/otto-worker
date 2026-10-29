-- 2026-10-29: the counters move from KV to D1 (option A). Workers KV's free
-- plan allows 1,000 writes a day and every question wrote two, so fourteen
-- active users would have exhausted it; D1 allows 100,000 rows written a day.
-- KV keeps the device tokens (read on every request, written at sign-in) and
-- the "capped until" marker (one write each time an account reaches a cap).
--
-- One row per account and window. `bucket` names the window:
--   d:YYYY-MM-DD      questions that UTC day          expires at its end
--   h:YYYY-MM-DDTHH   questions that UTC hour         expires at its end
--   total             a trial's lifetime questions    never expires
--   t:YYYY-MM-DD      tool calls that UTC day         expires at its end
--   k:YYYY-MM-DD      tasks created that UTC day      expires at its end
--   s:YYYY-MM-DD      browser model calls that day    expires at its end
-- An increment is one UPSERT (`n = n + 1`), atomic, where KV's was a read
-- and a write. The hourly cleanup deletes expired rows.
--
-- WITHOUT ROWID: the primary key is the table, so an increment writes one
-- row and no separate index entry.
CREATE TABLE IF NOT EXISTS counters (
  subject    TEXT NOT NULL,              -- account id; a trial's or legacy token's own token
  bucket     TEXT NOT NULL,
  n          INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,                    -- ms since epoch; NULL for `total`
  PRIMARY KEY (subject, bucket)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS counters_by_expiry ON counters(expires_at);
