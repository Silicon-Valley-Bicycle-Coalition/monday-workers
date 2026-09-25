-- How many Customer creates have been sent to Intuit under the current requestid (#33 second
-- review). A terminal rejection normally advances the requestid (create_attempt) so a fixed-up
-- redrive is a new request — but if an earlier send under the same requestid got no answer, that
-- send may have created this item's Customer, and a new requestid could create a second one. The
-- consumer checks create_sends before advancing; advancing resets it. Additive.
ALTER TABLE monday_events ADD COLUMN create_sends INTEGER NOT NULL DEFAULT 0;
