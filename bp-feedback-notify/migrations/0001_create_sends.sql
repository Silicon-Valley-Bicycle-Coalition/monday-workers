-- Per-item resend guard (#105): one row per BP Request item the Worker has emailed, or is
-- emailing right now. A webhook for an item claimed within the cooldown sends nothing.
-- claimed_at is epoch milliseconds. A failed send deletes its own claim, so a retry still goes out.
CREATE TABLE sends (
  item_id INTEGER PRIMARY KEY,
  claimed_at INTEGER NOT NULL
);
