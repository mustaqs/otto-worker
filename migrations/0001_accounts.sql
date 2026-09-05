-- Stage 1: trial. Accounts and Stripe columns are created now but unused until
-- stages 2 and 3, because a device row needs somewhere to point and adding the
-- foreign key later means rewriting the table on SQLite.

CREATE TABLE IF NOT EXISTS accounts (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  supabase_user_id   TEXT UNIQUE,
  plan               TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT UNIQUE,
  created_at         INTEGER NOT NULL,
  deleted_at         INTEGER
);

-- One account, many devices. NULL account_id means a trial with nothing behind
-- it: the invariant is that a device token is bound to exactly one account, or
-- to none and is a trial. Nothing in between, which is what keeps the branch
-- out of the function that runs on every question.
CREATE TABLE IF NOT EXISTS devices (
  token      TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id),
  label      TEXT,
  state      TEXT NOT NULL CHECK (state IN ('trial', 'active', 'revoked')),
  created_at INTEGER NOT NULL,
  last_seen  INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS devices_by_account ON devices(account_id);

-- NO PRICES AND NO TIER NAMES BEYOND THESE. Pricing is undecided, and a number
-- invented here would be quoted back as a decision later. Caps live in a table
-- rather than in code so that changing one is a row update — with the caveat
-- that the question path reads caps from KV, so a row update must be followed
-- by `npm run plans:apply`. Bench/check-plan-sync.sh fails if it is not.
CREATE TABLE IF NOT EXISTS plans (
  name            TEXT PRIMARY KEY,
  daily_cap       INTEGER NOT NULL,
  hourly_cap      INTEGER NOT NULL,
  trial_cap       INTEGER NOT NULL DEFAULT 0,
  stripe_price_id TEXT
);

-- The trial is the one number that is decided: ten questions, counted, not
-- days. The day and hour caps exist only to bound a runaway loop inside the
-- trial; they are not the trial's limit.
INSERT OR IGNORE INTO plans (name, daily_cap, hourly_cap, trial_cap)
VALUES ('trial', 10, 10, 10),
       ('free',  0,  0,  0);
