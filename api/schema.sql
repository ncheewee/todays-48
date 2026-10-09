-- Run once before deploying the session change. Safe to run again.
-- Remembered sign-ins: one row per signed-in device. Only a SHA-256 of the
-- token is kept, never the token itself.
create table if not exists challenge_sessions (
  token_hash   text primary key,
  google_sub   text not null,
  name         text not null,
  picture      text,
  created_at   timestamptz not null default now(),
  refreshed_at timestamptz not null default now(),
  expires_at   timestamptz not null
);

create index if not exists challenge_sessions_sub on challenge_sessions (google_sub);
create index if not exists challenge_sessions_expires on challenge_sessions (expires_at);

-- Optional housekeeping, e.g. daily:
-- delete from challenge_sessions where expires_at < now();
