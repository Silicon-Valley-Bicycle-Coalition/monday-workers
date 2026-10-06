-- One row per Eventbrite order this Worker has heard about, keyed on the order id — the
-- idempotency key (docs/superpowers/specs/2026-10-06-eventbrite-orders-design.md). The webhook
-- delivery carries only a pointer and the consumer re-fetches the order from Eventbrite every
-- time, so no payload, name or email is stored: nothing personal at rest, no retention purge.
CREATE TABLE orders (
  order_id TEXT PRIMARY KEY,
  event_id TEXT,
  last_action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  eventbrite_status TEXT,
  amount TEXT,
  currency TEXT,
  order_created TEXT,
  matched_donor_item_id TEXT,
  monday_item_id TEXT,
  error TEXT,
  deliveries INTEGER NOT NULL DEFAULT 1,
  received_at TEXT NOT NULL,
  written_at TEXT
);
