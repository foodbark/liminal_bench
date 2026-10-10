-- The bulletin board (functions/api/notes.js). Apply with
--   npx wrangler d1 execute liminal-bench --local --file=db/schema.sql    (wrangler pages dev)
--   npx wrangler d1 execute liminal-bench --remote --file=db/schema.sql   (production)
CREATE TABLE IF NOT EXISTS notes (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT    NOT NULL,      -- one line, 80 chars at most
  at   INTEGER NOT NULL,      -- ms since the epoch, when it was pinned
  who  TEXT    NOT NULL       -- salted daily hash of the poster's address, for the rate limit only
);
CREATE INDEX IF NOT EXISTS notes_at ON notes (at);
CREATE INDEX IF NOT EXISTS notes_who_at ON notes (who, at);

-- The answering machines behind the pay phone (functions/api/voicemail.js), 2026-10-10.
CREATE TABLE IF NOT EXISTS voicemail (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT    NOT NULL,      -- the digits dialed
  text   TEXT    NOT NULL,      -- the message, 120 chars at most
  at     INTEGER NOT NULL,      -- ms since the epoch
  who    TEXT    NOT NULL       -- salted daily hash of the caller's address, for the rate limit only
);
CREATE INDEX IF NOT EXISTS voicemail_number_at ON voicemail (number, at);
CREATE INDEX IF NOT EXISTS voicemail_who_at ON voicemail (who, at);
