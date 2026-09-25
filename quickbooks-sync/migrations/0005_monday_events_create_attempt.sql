-- Redrive discriminator for Monday -> QuickBooks Customer creates (#33 review). Creates send
-- Intuit's requestid so a retry whose first response was lost gets the original Customer back;
-- but Intuit also replays a *failed* response for a repeated requestid. create_attempt counts
-- terminal (not retried) failures and goes into the requestid, so fixing the item in Monday and
-- redriving the row makes a genuinely new request. Transient failures keep the same requestid.
-- Additive.
ALTER TABLE monday_events ADD COLUMN create_attempt INTEGER NOT NULL DEFAULT 0;
