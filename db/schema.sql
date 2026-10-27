-- The bulletin board (functions/api/notes.js). Apply with
--   npx wrangler d1 execute liminal-bench --local --file=db/schema.sql    (wrangler pages dev)
--   npx wrangler d1 execute liminal-bench --remote --file=db/schema.sql   (production)
CREATE TABLE IF NOT EXISTS notes (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT    NOT NULL,      -- one line, 80 chars at most
  at   INTEGER NOT NULL,      -- ms since the epoch, when it was pinned
  who  TEXT    NOT NULL,      -- salted daily hash of the poster's address, for the rate limit only
  x    REAL,                  -- where it was placed by hand (2026-10-27): the paper's center as
  y    REAL                   -- fractions of the cork; null takes a slot
);
-- tables from before the placing (2026-10-27) take the columns once, by hand:
--   npx wrangler d1 execute liminal-bench --remote --command "ALTER TABLE notes ADD COLUMN x REAL; ALTER TABLE notes ADD COLUMN y REAL; ALTER TABLE posters ADD COLUMN x REAL; ALTER TABLE posters ADD COLUMN y REAL"
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
-- a few tens of kilobytes each. Nothing on the board is swept (2026-10-27): a note or a poster
-- stays, fading over a year, until it is torn down, the oldest buried under the newer; at FULL
-- pieces of paper (40, notes and posters together, _board.js) there is not a pin left and a
-- pin is refused until someone pulls something down.
CREATE TABLE IF NOT EXISTS posters (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  png  TEXT    NOT NULL,      -- the picture, base64
  w    INTEGER NOT NULL,      -- art pixels
  h    INTEGER NOT NULL,
  k    INTEGER NOT NULL DEFAULT 0,   -- the size chosen: 1 handbill, 2 flyer, 3 big sheet; 0 lets the board pick
  at   INTEGER NOT NULL,      -- ms since the epoch
  who  TEXT    NOT NULL,      -- salted daily hash of the poster's address, for the rate limit only
  x    REAL,                  -- placed by hand, as for notes
  y    REAL
);
-- a posters table from before the size column (2026-10-10) takes it once, by hand:
--   npx wrangler d1 execute liminal-bench --remote --command "ALTER TABLE posters ADD COLUMN k INTEGER NOT NULL DEFAULT 0"
CREATE INDEX IF NOT EXISTS posters_at ON posters (at);
CREATE INDEX IF NOT EXISTS posters_who_at ON posters (who, at);

-- One shared copy of a feed the Functions fetch for everyone (2026-10-21): the aircraft feed
-- (functions/api/flights.js) keeps its last answer here so the upstream is asked once every
-- 30 s worldwide, not once per edge location. The Function makes the table itself on first
-- use; it is here so the schema is in one place.
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT    PRIMARY KEY,
  value TEXT    NOT NULL,
  at    INTEGER NOT NULL       -- ms since the epoch, when it was stored
);
