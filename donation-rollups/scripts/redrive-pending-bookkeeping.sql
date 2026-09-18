-- Bookkeeping after scripts/redrive-pending.mjs re-drives stuck pending_recomputes rows.
--
-- The re-drive sends ONE synthetic webhook per distinct owner (a recompute is a full per-owner
-- rebuild), so once that message is 'written', every other stuck row of the same owner is
-- materialized too — but the consumer only updates the row it was handed. These statements
-- mark the rest, stamped with the owner's recompute time, so the table stops reporting
-- bookkeeping debt that no longer exists.
--
-- '{{SINCE}}' is the re-drive's start time (ISO UTC). `redrive-pending.mjs --bookkeep` fills it
-- in; for hand use, replace it first, then:
--   npx wrangler d1 execute svbc-donation-rollups --remote -y --file scripts/redrive-pending-bookkeeping.sql
-- (-y matters without a TTY — wrangler's confirm prompt otherwise cancels silently with exit 0.)
-- Only rows received before the run are touched, and only where an owner recompute from this
-- run actually landed, so it is safe to run more than once.

-- 1. Owners known via the reverse index.
UPDATE pending_recomputes SET status='written', error=NULL,
  owner_item_id=(SELECT l.owner_item_id FROM donation_links l WHERE l.donation_item_id=pending_recomputes.donation_item_id),
  owner_board=(SELECT l.owner_board_id FROM donation_links l WHERE l.donation_item_id=pending_recomputes.donation_item_id),
  written_at=(SELECT max(r.written_at) FROM pending_recomputes r JOIN donation_links l ON l.donation_item_id=pending_recomputes.donation_item_id
              WHERE r.owner_item_id=l.owner_item_id AND r.status='written' AND r.written_at >= '{{SINCE}}')
WHERE status IN ('queued', 'received', 'failed') AND received_at < '{{SINCE}}'
  AND EXISTS (SELECT 1 FROM pending_recomputes r JOIN donation_links l ON l.donation_item_id=pending_recomputes.donation_item_id
              WHERE r.owner_item_id=l.owner_item_id AND r.status='written' AND r.written_at >= '{{SINCE}}');

-- 2. Rows whose owner is known only from the gift ledger (link row missing).
UPDATE pending_recomputes SET status='written', error=NULL,
  owner_item_id=(SELECT g.owner_item_id FROM gifts g WHERE g.monday_item_id=pending_recomputes.donation_item_id),
  owner_board=(SELECT g.owner_board_id FROM gifts g WHERE g.monday_item_id=pending_recomputes.donation_item_id),
  written_at=(SELECT max(r.written_at) FROM pending_recomputes r JOIN gifts g ON g.monday_item_id=pending_recomputes.donation_item_id
              WHERE r.owner_item_id=g.owner_item_id AND r.status='written' AND r.written_at >= '{{SINCE}}')
WHERE status IN ('queued', 'received', 'failed') AND received_at < '{{SINCE}}'
  AND EXISTS (SELECT 1 FROM pending_recomputes r JOIN gifts g ON g.monday_item_id=pending_recomputes.donation_item_id
              WHERE r.owner_item_id=g.owner_item_id AND r.status='written' AND r.written_at >= '{{SINCE}}');

-- 3. What's left.
SELECT status, count(*) n, min(received_at) oldest, max(written_at) newest_write FROM pending_recomputes GROUP BY status;
SELECT donation_item_id, received_at, owner_item_id, substr(error, 1, 120) error FROM pending_recomputes WHERE status <> 'written' LIMIT 20;
