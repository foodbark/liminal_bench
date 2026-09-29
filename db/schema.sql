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
