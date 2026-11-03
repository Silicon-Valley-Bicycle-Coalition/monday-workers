CREATE TABLE geocodes (
  item_id      TEXT PRIMARY KEY,
  address_hash TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('match', 'nomatch')),
  lat          REAL,
  lng          REAL,
  geocoded_at  TEXT NOT NULL
);
