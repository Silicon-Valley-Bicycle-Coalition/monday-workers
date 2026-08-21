# membership-reminders

**Status:** Decided — build (scoped 2026-08-21).
**Priority:** Post-migration, but **time-sensitive**: Salesforce's renewal-reminder automation
dies at retirement, and until this ships nobody is asked to renew. Build it in the first
post-cutover wave, not "eventually."
**Owner:** Unassigned.
**Stack:** Hono + TypeScript, daily **Cron Trigger**, same least-privilege-token shape as the
other Workers. No D1 needed — idempotency state lives on the board items themselves.

## The ask

Replace the Salesforce workflow rules that email members 6, 4, and 2 weeks before their
membership expires. With ~1,500 active members and yearly (not monthly) renewal as the dominant
pattern, these reminders are the org's recurring-revenue mechanism — the one piece of Salesforce
automation whose silent disappearance directly costs money.

## How it works

Once daily:

1. Query the Donors board for items where **Membership Status = Active** and **Member Until** is
   exactly 42, 28, or 14 days out (one query per stage, using Monday's date filters).
2. Skip items with **Membership Tier = Lifetime** or a blank Member Until (belt and suspenders —
   the import leaves Member Until blank for Lifetime precisely so date automations never touch
   them).
3. For each match, send that stage's templated renewal email to the item's email column.
4. Stamp the item's **Reminders Sent** column (a text/tag column, e.g. appending `6w`, `4w`,
   `2w` with the term-end date) before considering the send complete. On the next run, items
   already stamped for the current term's stage are skipped — re-runs and overlapping cron
   firings are idempotent, and a member who renews (new Member Until) naturally resets to a
   clean slate for the next term.

Renewal itself is not this Worker's job: a renewal arrives as a new membership payment, and the
import-era rule (latest term's end date → Member Until, status → Active) is maintained by
whatever ingests post-cutover payments.

## Email sending

Use the same outbound-email mechanism `donor-portal` settles on for magic links — one deliverable
choice, two consumers. Templates for the three stages live in this Worker; keep them plain
(subject, greeting, expiration date, renewal link) and let the copy be staff-editable via config
rather than code.

## Deliberately not in v1

* **The 3-stage new-member welcome drip** (Salesforce's other membership email automation) — same
  machinery would work (trigger on Member Since instead of Member Until), but it's a separate
  decision and separate templates. Flagged in the plan as a possible follow-up.
* **Grace-period handling** — the status model is a hard Active→Lapsed flip on Member Until
  (dwk's call, 2026-08-21). If staff later add a Grace status, this Worker needs no change; the
  reminder window ends at expiration either way.
* **Lapsed-member win-back emails** — a campaign question for Mailchimp segments, not scheduled
  infrastructure.

## Monday-side prerequisites (from the import, see the private repo's `docs/05` §2)

* Donors board columns: Membership Status, Membership Tier, Member Since, Member Until — written
  by `salesforce-import`.
* The **Reminders Sent** column this Worker stamps — add it during sandbox-week board build-out.
* The native automation "When Member Until arrives → set Membership Status to Lapsed" — Monday
  configuration, not this Worker.
