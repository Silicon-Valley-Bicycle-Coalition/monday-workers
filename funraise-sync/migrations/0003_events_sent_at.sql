-- Funraise sends no per-delivery id, only the envelope's send time (`sentAt`, epoch ms). It is
-- stored so an out-of-order redelivery of an older edit can be recognized and ignored instead
-- of overwriting a newer payload — ordering is by send time, not arrival. NULL for rows from
-- before this column existed and for envelopes without a usable time; those never block an update.
ALTER TABLE events ADD COLUMN sent_at INTEGER;
