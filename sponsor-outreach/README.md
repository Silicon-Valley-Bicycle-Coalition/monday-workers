# sponsor-outreach

**Status: requirements only. The Worker isn't built yet.**

The Sponsor Outreach board lets Martha build each year's corporate sponsor segments (Lapsed,
Current, Prospect, hand-picked) from 15 years of sponsorship history. She starts each segment's
email from it. The send goes through her own Gmail and is logged on each recipient's timeline.
Design: [`docs/superpowers/specs/2026-11-09-sponsor-outreach-board-design.md`](../docs/superpowers/specs/2026-11-09-sponsor-outreach-board-design.md).

What exists so far:

* `config/event-names.json` maps the event text in Sponsorship Cycle values from 2011 on to the
  Sponsorships board's Event labels. `scripts/sponsor-outreach-setup.mjs cycles` checks it against
  every ledgered sponsorship gift, and fails while any event text is unmapped. Martha approves the
  table.
* The one-time setup: `scripts/sponsor-outreach-setup.mjs`, runbook in
  `docs/runbooks/sponsor-outreach-setup.md`.

**Reading history:** most gifts on the Donations board are archived in place, and `items_page`
never returns archived items. The full sponsorship history comes from each Organization's
🔒 Gift Ledger (JSON), which donation-rollups writes from its D1 ledger, plus `items(ids:)` for
each gift's Sponsorship Cycle. The Worker must read history the same way, or from the D1 ledger.
