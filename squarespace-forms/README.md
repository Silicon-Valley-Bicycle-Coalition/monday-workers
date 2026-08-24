# squarespace-forms

**Status:** Decided — **no Worker needed** (resolved 2026-08-22). See
[implementation design](../docs/superpowers/specs/2026-08-22-squarespace-forms-design.md) for the
form inventory and the reasoning.
**Priority:** N/A — nothing to build here beyond a Monday board/form and two page edits.
**Owner:** dwk.
**Stack:** None. See below.

## The ask

Squarespace form submissions on bikesiliconvalley.org were fully manual: submission → email
notification → hand-entered into Salesforce/Monday. No native Monday integration exists, and
Squarespace's public API surface is commerce-only (Orders, Products, Inventory, Discounts,
Transactions, Analytics, a commerce Contacts API, Webhook Subscriptions for storefront events) —
**there is no Forms API and no form-submission webhook.** That part of the original ask still
holds; what changed is the fix.

## Resolution: embed Monday forms directly, no Worker

A full form inventory (see the [implementation design](../docs/superpowers/specs/2026-08-22-squarespace-forms-design.md))
found only 3 forms exist site-wide — and one of them, Contact, is **already** an embedded Monday
WorkForm rather than a native Squarespace form block. That's evidence the right fix isn't a
Cloudflare Worker polling a Google Sheets storage destination (the shape originally planned here):
it's replacing each remaining native form with an embedded Monday form, the same way Contact
already works. No Worker, no D1, no Cron Trigger, no Google service account — and submissions land
in Monday on submit instead of up to 30 minutes later.

```
Squarespace Form Block → swapped for → embedded Monday WorkForm (iframe)
  ▼
Monday board, submission on save — no polling, no bridge infrastructure
```

The two remaining forms and their resolution:

* **Volunteer Interest** (`/get-involved/volunteer`) → embed the existing **"Volunteer with us!"**
  form already built on the *Volunteer registration management* board
  ([`.../boards/8846285372`](https://bikesiliconvalley.monday.com/boards/8846285372)). No new
  Monday-side work.
* **Bike Parking Request** (`/learn-ride/bike-parking`) → new **Bike Parking Requests** board with
  its own Monday form, matching the current site form's fields.

## APIs & auth

None needed beyond normal Monday.com board/form administration — no Worker secrets, no service
account, no Squarespace-side auth. The one manual step is swapping each page's Form Block for an
embed block in the Squarespace page editor, since Squarespace has no content API for this.

## Sources

* [Squarespace Commerce APIs overview](https://developers.squarespace.com/commerce-apis/overview)
* [Webhooks for form submission (Squarespace Forum — confirms none exists)](https://forum.squarespace.com/topic/168849-webhooks-for-form-submission/)
* [Managing form and newsletter storage](https://support.squarespace.com/hc/en-us/articles/205814638-Managing-form-and-newsletter-storage)
* [Implementation design](../docs/superpowers/specs/2026-08-22-squarespace-forms-design.md) — full
  form inventory, Monday workspace findings, and the no-Worker decision.
* Plan section: Squarespace (Integrations) — `migration-plan.md` (private planning repo)
