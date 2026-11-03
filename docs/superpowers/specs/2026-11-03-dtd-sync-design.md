# dtd-sync — Design

**Status:** Draft design, pre-implementation (2026-11-03).
**Worker:** `dtd-sync/` (new). Touches `member-portal` and the overview dashboards / `report-digests`.

## Why

SVBC pays for Double the Donation (DTD, "360MatchPro"), which finds out where a donor works and
prompts them to ask their employer for a matching gift. DTD gets donations two ways: Funraise sends
online gifts straight to DTD, and until 2026-10-23 DTD also pulled gifts from Salesforce every few
hours. That Salesforce feed was the only way DTD saw gifts Funraise doesn't handle: Eventbrite
ticket donations and hand-entered gifts (in October, about three quarters of the Salesforce-fed
records were Eventbrite). It stopped when the token lapsed, and the integration was removed from
DTD on 2026-11-03 because Salesforce is being retired. Nothing has replaced it, so donors who give
outside Funraise currently get no matching-gift prompt.

Separately, nobody at SVBC sees what DTD knows without logging into DTD. Three groups need it:

- **Staff** reach out personally to donors who are eligible but haven't asked their employer. DTD's
  own automated emails keep running; staff outreach is a personal touch on top, not a replacement.
- **Donors**, in the member portal, want proof that a match happened (date and amount), or, if not
  yet, a way to start one.
- **The board, and grant/contract funders**, want to know how effective the matching-gift program
  is at bringing in new money. Funders often require this as part of a contract.

DTD has no Monday.com integration (none in its partner directory as of 2026-11-03), so this is a
Worker against DTD's REST API.

## Goals

1. **Monday → DTD:** every gift DTD should prompt for, that Funraise doesn't already send, reaches
   DTD. Restores what the Salesforce feed did.
2. **DTD → Monday:** each Donations item that DTD knows about carries DTD's matching-gift status and
   the donor's employer as DTD identified it, kept current.
3. **Pairing:** a match that arrives (a Benevity disbursement or, rarely, a company check) is linked
   to the gift it matched.
4. **Portal:** a donor sees, per gift, the match date and amount if matched; a link to start their
   employer's match if the employer is known; otherwise the "does my employer match?" lookup.
5. **Reporting:** one set of program-effectiveness numbers for the board and for funder reports.

## Non-goals

- Replacing DTD's automated donor emails, or building reminder sequences/tasks in Monday. Staff
  reminders are personal; Monday only shows them who to call.
- Telling DTD that a match was paid. DTD's API has no endpoint to change a donation's match stage
  (see API below); that stays a manual step in DTD's UI if staff want DTD's own stats complete.
- Migrating anything from the Salesforce `dtd` package. It never wrote data (the company lookup
  is empty on every record) and its staff search component was never placed on a layout.
- Grant "matching funds" accounting (proving specific gifts as a grant's required cost share).
  Funders here ask about program effectiveness, not gift-level match proof.

## Anti-goals (would make this a failure even if it works)

- DTD prompting a donor about a gift that shouldn't be matched: a sponsorship, grant, contract,
  membership-only payment, or a gift that *is* itself an employer match. (The old Salesforce feed
  did let a sponsorship and a matching gift through.)
- The same gift reaching DTD twice (once from Funraise, once from this Worker), producing double
  emails to a donor.
- DTD's private API key reaching a browser, a log, or the portal.
- Third-party JavaScript loaded on any portal page that shows donor data.

## DTD API (verified 2026-11-03)

Base `https://doublethedonation.com/api/360matchpro/v1/`, swagger at
`https://doublethedonation.com/api/360matchpro/v1/swagger.json`. DTD's docs say custom API use is
for Enterprise clients, but a read with SVBC's Standard-plan private key succeeded (HTTP 200, no
session cookie), passing the key as the `key` query parameter. Treat continued access as a risk to
confirm with DTD, not a given.

Endpoints this design uses:

| Endpoint | Use |
|---|---|
| `GET get_updated_donations?since=&to=` | DTD → Monday poll. Array of donation records; capped at 100,000 per call. |
| `GET get_donation?donation_identifier=` | Spot lookups, reconciliation. |
| `POST register_donation` | Monday → DTD push. JSON body; schema in DTD's "Custom Implementation" doc. |
| `GET companies/{company_id}` | Company program details (`url_forms`, `url_guidelines`, min/max, ratio). |

Fields seen on a donation record: `donation_identifier`, `source` (null for Funraise,
`salesforce_crm` for the old feed), `campaign`, `donation_datetime`, donor name/email/phone,
`company_name`, `doublethedonation_company_id`, `employer_identification_status` (`:new`,
`:complete`), `status` and `matching_gift_status` (keyword strings such as
`:identification-in-progress`, `:waiting-for-donor-action`, `:waiting-for-verification`,
`:closed-program-eligibility`, `:closed-no-matching-gift-program`), `matched_amount`,
`promise_amount`, `match_submitted_verified_at`, `last_donor_action`, `plugin_link` (a per-donor
link to SVBC's matching-gift page that opens straight to their company), `matching_gift_offered`,
`custom_fields`. The full set of status keywords isn't documented; the Worker must store unknown
values verbatim rather than fail.

Identifiers: for Funraise gifts `donation_identifier` is the bare Funraise transaction id, the same
id Donations → **Funraise ID** already stores. Old Salesforce-fed records carry the Salesforce
Opportunity Id, which Donations → **Salesforce ID** stores for migrated gifts.

## How it works

One new Worker, `dtd-sync`, in the house shape (TypeScript, Hono only if it needs routes,
`config/sandbox.json` + `config/svbc.json`, D1 ledger, write switch, sandbox environment first).
Cron-driven; DTD has no webhooks.

### DTD → Monday (status)

On a schedule (hourly is plenty; DTD itself updates on donor actions and its own email cadence):

1. `get_updated_donations` since the last successful watermark (stored in D1), with overlap.
2. For each record, find the Donations item by `donation_identifier` → Funraise ID, else
   Salesforce ID, else the Worker's own pushed id (below). Unmatched records are logged in D1 for
   review, not created in Monday — every gift is created by its own source integration.
3. Write the new columns (below) when changed. Store the raw DTD status keyword, mapped to a
   staff-readable label through config.
4. If the record has a `doublethedonation_company_id`, set People → **DTD Company ID** and
   **DTD Company** from the most recent such record. **Never write People → Employer** (designer's
   call): `benevity-import` resolves people by exact name + Employer text, and DTD's company names
   ("Google") won't match Benevity's ("Google, LLC"), so writing them there would quietly break
   that matching.

### Monday → DTD (registration)

On a schedule, find Donations items that should be prompted and haven't been sent:

- **Send:** Gift Type = Donation or **Event Ticket** (decided 2026-11-03: Eventbrite orders at the
  full order amount, as the old Salesforce feed did; DTD and the employer sort out what's
  matchable), plus any other config-listed types; Status = Received, Amount > 0,
  Donor is a Person with an email, date within a config window (DTD's old feed used 30 days), and
  **no** Funraise ID (Funraise already sends those).
- **Never send:** Gift Type Matching Donation, Sponsorship, Grant, Contract, Membership (config list);
  anything with a Benevity Transaction ID (Benevity gifts are workplace giving, already matched or
  matchable inside Benevity); Anonymous Donor checked; Refunded/Failed/Pending.
- `register_donation` with the Monday item id as `donation_identifier` (prefixed, e.g.
  `monday-<itemId>`, so it can never collide with a Funraise id), `campaign` from config, donor name,
  email, phone, and address if present. Record the send in D1 and on the item, so it is sent once.
- DTD's account-level duplicate rule (same email, same amount, within N days) stays enabled as a
  second guard.

### Pairing a match to its gift

New Donations column **Matches gift** (connect → Donations). Filled on Matching Donation items:

1. **Same Benevity row:** the employee gift and the match share a Benevity Transaction ID (`<id>` and
   `<id>-match`). Link them; certain.
2. **Otherwise** (the original gift came through Funraise, Eventbrite or by hand; the match came
   later from Benevity or a check): candidates are the same Donor's gifts in the prior N months
   (config; start at 18) whose DTD company matches the match's Matched By organization, and whose
   amount is consistent with the company's ratio and limits. Exactly one candidate → link it. Zero
   or several → leave blank and flag for staff (a "Match pairing" status: Auto / Needs review /
   Staff), the same pattern Attribution uses.
3. Staff can always set or correct the link by hand; the Worker never overwrites a Staff value.

Rare check matches are hand-entered as Gift Type = Matching Donation and go through step 2.

### Monday changes

Donations (new columns):

- **Match Status** (status): staff-readable DTD stage, written only by the Worker, plus "Matched" set
  when a paired match exists (that wins over DTD's stage).
- **DTD Status (raw)** (text): DTD's keyword, for debugging and for labels not yet mapped.
- **Match Company** (text): DTD's company name for this gift.
- **Matches gift** (connect → Donations) and **Match pairing** (status), as above.
- **Sent to DTD** (date): when the Worker registered it; blank for Funraise gifts.

People (new columns): **DTD Company ID** and **DTD Company** (text), plus the DTD `plugin_link` for the donor's most
recent gift (link column) so the portal and staff have a working "start your match" link.

A Donations board view, "Matching gifts to follow up": Match Status = waiting for donor, newest
first, for staff's personal outreach.

### Member portal

- **Giving history** (existing page, no third-party scripts): per gift, show
  - matched: the paired match's date and amount ("Matched by Google on 2026-12-15: $250");
  - employer known, not matched: "Your employer may match this gift" with the donor's DTD
    `plugin_link`, and the company's `url_guidelines` if cached;
  - otherwise nothing per gift, and a single link to the matching-gifts page.
- **Matching-gifts page** (existing, gated on the public key): set
  `matchingGifts.doubleTheDonationPublicKey` to SVBC's public plugin key and verify the embed under
  the page's CSP. This page keeps rendering zero donor PII.
- **Match items stay as they are** (decided 2026-11-03): a Matching Donation linked to the
  employee as Donor keeps appearing as its own row in their giving history and in their totals and
  tax letter, exactly as today. The new per-gift line is added on top; the portal's donation query
  and letter totals don't change.
- The portal reads only Monday. It never calls DTD with the private key.

### Reporting: program effectiveness

Computed from Monday, per fiscal year, available as a dashboard section and a dated snapshot for
funder reports:

- **Funnel:** gifts DTD screened → employer identified → match-eligible → donor submitted → match
  paid, with conversion at each step (counts from Match Status; paid from paired matches).
- **New money:** match dollars received (Funding Stream = Matching Donations, already tagged by
  `donation-rollups`), and match dollars per dollar of matched gifts.
- **New givers:** organizations whose first-ever gift to SVBC was a match; donors whose gift was
  matched for the first time.
- **Trend:** the same figures year over year.

Where it lives (overview dashboard widgets vs. a `report-digests` section vs. both) is the builder's
call; the board and funders need the same numbers.

## Constraints

- **Sandbox first.** Build and rehearse against the sandbox Donations/People boards and DTD's API
  with a test campaign name; DTD has no sandbox, so pushes during rehearsal must be to a clearly
  named test campaign, and test donations deleted from DTD afterwards (DTD's Donations page has
  Delete).
- **Secrets:** the DTD private key as a Worker secret only; never logged. Rotate the current key
  before first use (it was exposed in a working session on 2026-11-03).
- **Public repo:** no donor data in fixtures, logs, or docs.
- Monday writes go through the existing Monday auth broker and write switch, like the other Workers.
- `check-log-safety` applies: no `console.*` that could print an email.

## Cutover

- At go-live, the Monday → DTD push replaces the Salesforce feed. Gifts made between 2026-10-23 and
  go-live outside Funraise were never sent to DTD; a one-time backfill of that window (same send
  rules) closes the gap, if staff want those donors prompted late.
- DTD's Salesforce integration is already removed.

## Open, for the builder

- Exact staff-facing labels for Match Status and the DTD keyword → label map (config).
- Pairing window and amount tolerance defaults.
- Poll cadence, and D1 schema details.
- Whether to cache `companies/{id}` details in D1 or on an Organizations item.

## Open, needs SVBC

- Confirm with DTD that API access on the Standard plan is supported, not incidental.
- Whether any Gift Types beyond Donation and Event Ticket should be sent to DTD (e.g. membership
  payments above a threshold?). Default: no.
