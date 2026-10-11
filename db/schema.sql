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

-- Notes torn down (2026-10-10). Anyone can tear any note off the board, the way a real board
-- works. A posted note is deleted and the tearing recorded here for the rate limit; a default
-- note (key seed:N, from the painting's config) stays down for the life of a note and then
-- comes back, as if someone put up a fresh flyer.
CREATE TABLE IF NOT EXISTS torn (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  key  TEXT    NOT NULL,      -- note:ID or seed:N
  at   INTEGER NOT NULL,      -- ms since the epoch
  who  TEXT    NOT NULL       -- salted daily hash of the tearer's address, for the rate limit only
);
CREATE INDEX IF NOT EXISTS torn_key_at ON torn (key, at);
CREATE INDEX IF NOT EXISTS torn_who_at ON torn (who, at);

-- Posters (2026-10-10): pictures people bring, pixelated in their browser (src/pixelate.js) and
-- pinned beside the notes (functions/api/posters.js). The PNG the page made, as base64 text:
-- a few tens of kilobytes each, six on the board at most, blown away with the notes.
CREATE TABLE IF NOT EXISTS posters (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  png  TEXT    NOT NULL,      -- the picture, base64
  w    INTEGER NOT NULL,      -- art pixels
  h    INTEGER NOT NULL,
  k    INTEGER NOT NULL DEFAULT 0,   -- the size chosen: 1 handbill, 2 flyer, 3 big sheet; 0 lets the board pick
  at   INTEGER NOT NULL,      -- ms since the epoch
  who  TEXT    NOT NULL       -- salted daily hash of the poster's address, for the rate limit only
);
-- a posters table from before the size column (2026-10-10) takes it once, by hand:
--   npx wrangler d1 execute liminal-bench --remote --command "ALTER TABLE posters ADD COLUMN k INTEGER NOT NULL DEFAULT 0"
CREATE INDEX IF NOT EXISTS posters_at ON posters (at);
CREATE INDEX IF NOT EXISTS posters_who_at ON posters (who, at);
