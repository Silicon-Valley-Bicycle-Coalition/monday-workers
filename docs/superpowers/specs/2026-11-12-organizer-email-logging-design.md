# Logging organizer email to Person and Organization (#121)

Date: 2026-11-12. Status: done 2026-11-17; board setup done 2026-11-12, matching checked against production staff mail 2026-11-17 in place of a scripted BCC test. Supersedes the `email-log` Worker
(`2026-10-19-email-log-design.md`) for this request.

## Why

Zachary Kearsley (Bike Parking) wants to BCC Monday on his coordination email with event
organizers and see those messages on the organizer's Person and on their Organization.
SVBC already logs email through Monday CRM's **Emails & Activities** (decided 2026-11-04;
monday-migration `docs/06` §3), but that only covers part of his case:

* Emails & Activities logs a message on an item only when an address in the thread is in that
  item's email column. Its view is on **People** and **Event Registrations** only.
* Organizers are usually emailed at **work** addresses, which live on **Affiliations**
  (`Work Email`), not People. Those messages match nothing today.
* **Organizations** has no email column and no Emails & Activities view, so nothing can show
  there.

## Approaches

1. **Extend Emails & Activities (chosen, 2026-11-12).** Monday setup plus staff docs, no code.
   Keeps the 2026-11-04 decision and the one way of logging email that staff already learned.
2. **Build the `email-log` Worker.** Could link a message to Person and Organization in one
   item, but reverses the 2026-11-04 decision, reopens `log@` (which the staff guide now tells
   staff not to use), and is a new Worker to run. Rejected.
3. **People only, as today.** No work, but most organizer email stays unmatched. Rejected.

## Design

1. **Affiliations gets the Emails & Activities item view.** Mail to or from an affiliation's
   `Work Email` logs on that affiliation, which connects to both the Person and the
   Organization. This is the main path for Zachary.
2. **Organizations gets an `Email` column (email type) and the Emails & Activities view.** For an
   organization's shared address (`events@`, `info@`) where no Person exists. Mail to that
   address logs on the Organization itself. *(My call: no Person is ever created from email,
   same anti-goal as the old spec.)*
3. **What the Organization shows.** Its own Emails & Activities timeline (shared address only),
   plus its existing **Affiliations** connection, which leads to each affiliation's logged email.
   Emails & Activities doesn't roll timelines up across connections, so an organization's page
   won't list its affiliations' emails in one place. *(Accepted limit; revisit only if
   Zachary finds the click-through too slow.)*
4. **Zachary's setup.** Confirm he has a CRM seat, connect his Gmail under Emails & Activities,
   and pick the "only log emails BCC'd to your Emails & Activities address" setting, as the
   protocol recommends.
5. **Docs.** Update monday-migration `docs/06` §3 (Affiliations and Organizations now log email,
   when to use which) and `docs/22` (where the view lives). Add a short how-to for Zachary
   and the Bike Parking team. Mark the `email-log` spec and plan superseded.

## Must be checked live before docs go out

* The Emails & Activities view can be added to Affiliations and Organizations (both are in the
  CRM workspace, like People).
* It matches on `Work Email` (an email-type column) on Affiliations, and on a new `Email` column on
  Organizations.
* When one address is on both a People item and an Affiliation, find out whether the message
  logs on both or only one, and write the result in `docs/06`.
* A BCC from a connected staff Gmail to an organizer at a work address shows on the affiliation.
  Someone with a connected mailbox has to send this one; Claude doesn't send it.

## Non-goals

* No Worker, no `log@` address, no roll-up of affiliation email onto the Organization.
* No matching by email domain to guess an organization.
