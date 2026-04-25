CREATE TABLE IF NOT EXISTS email_outbox (
  id             INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "to"           VARCHAR(320) NOT NULL,
  subject        VARCHAR(998) NOT NULL,
  text           TEXT NOT NULL,
  html           TEXT,
  kind           VARCHAR(64),
  status         VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_outbox_pending_idx
  ON email_outbox (next_attempt_at)
  WHERE status = 'pending';
