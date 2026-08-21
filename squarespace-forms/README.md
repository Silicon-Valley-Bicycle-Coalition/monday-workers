# squarespace-forms

**Status:** Decided — build.
**Priority:** Post-migration, non-blocking.
**Owner:** dwk.
**Stack:** Hono + TypeScript + D1, on a **Cron Trigger** (every 15–30 minutes), D1 for last-processed
state.

## The ask

Squarespace form submissions on bikesiliconvalley.org are currently fully manual: submission →
email notification → hand-entered into Salesforce. No native Monday integration exists, and
Squarespace's public API surface is commerce-only (Orders, Products, Inventory, Discounts,
Transactions, Analytics, a commerce Contacts API, Webhook Subscriptions for storefront events) —
**there is no Forms API and no form-submission webhook.**

## Needed first: form inventory

Before building anything, inventory every form on the live site and map each one to its intended
Monday destination (board/group). A contact form, a donor signup, and a volunteer interest form
probably don't all belong in the same place — this mapping is a prerequisite deliverable, not
something the Worker can infer.

## The bridge point

Every Squarespace Form block can add **Google Drive** as a storage destination alongside its
default email notification — built into every Squarespace plan, no Zapier or paid add-on required.
Given the site "isn't that dynamic" (low submission volume), periodic polling is a proportionate
match, not a webhook-driven design.

## Data flow

```
Squarespace Form block → Google Drive (Sheets) storage destination (in addition to email)
  ▼
Cloudflare Worker, Cron Trigger every 15-30 min
  │  reads each form's sheet via the Google Sheets API (service account)
  │  diffs against a D1-stored last-processed row index per sheet
  ▼
Website & Blog board (https://bikesiliconvalley.monday.com/boards/8846647961)
```

The Website & Blog board today has just Name + Files, one item, no automations — board design
(groups per form type, per the inventory above) is part of this work, not a prerequisite someone
else has to finish first.

## APIs & auth

* **Google Sheets API** via a service account — read-only access to each form's destination sheet.
  **Scope it to only those sheets**: share each form-response sheet to the service account
  directly rather than granting any Drive-wide access, so the key stored in Worker secrets is a
  long-lived credential to a handful of known sheets, not to SVBC's Drive.
* No Squarespace-side auth needed at all, since the integration point is the Drive/Sheets
  destination, not the Squarespace API.

## Sources

* [Squarespace Commerce APIs overview](https://developers.squarespace.com/commerce-apis/overview)
* [Webhooks for form submission (Squarespace Forum — confirms none exists)](https://forum.squarespace.com/topic/168849-webhooks-for-form-submission/)
* [Managing form and newsletter storage](https://support.squarespace.com/hc/en-us/articles/205814638-Managing-form-and-newsletter-storage)
* Plan section: Squarespace (Integrations) — `migration-plan.md` (private planning repo)
