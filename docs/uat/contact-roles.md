# UAT script: Organization contacts on opportunities (contact-roles)

**Status 2026-11-11: built, not deployed.** This script is for the sandbox once it is switched
on; there is nothing to try yet.

## What it does

An opportunity (a sponsorship, a grant, a matched donation) belongs to an organization, and
staff want to see which people there are its contacts. You say who by giving a person a **role**
on their **affiliation** with the organization (for example "Sponsorship" for someone who is a
sponsor contact at Acme). About every ten minutes the **Contacts** column on each opportunity
fills itself in with the people who hold the matching role at that opportunity's organization.
You never edit **Contacts**; it is locked and gets overwritten.

Two role columns live on **Affiliations**: **SVBC Roles** is the confirmed list, and the only one
that counts. **Proposed Roles** holds suggestions made from old data; they do nothing until you
confirm them by moving the label into **SVBC Roles**. Only **Current** affiliations count.

## Try it (sandbox v4)

Boards: [Affiliations](https://bikesiliconvalley.monday.com/boards/18437342615),
[Sponsorships](https://bikesiliconvalley.monday.com/boards/18439568033),
[Grants & Contracts](https://bikesiliconvalley.monday.com/boards/18439568066),
[Donations](https://bikesiliconvalley.monday.com/boards/18437342657).

1. **Add a role.** On Sponsorships, pick a sponsorship that has a Sponsor and note the
   organization. On Affiliations, find a **Current** affiliation of some person with that
   organization and add **Sponsorship** to **SVBC Roles**. Within about ten minutes that person
   should appear in **Contacts** on the sponsorship.
2. **Confirm a proposed role.** On Affiliations, open the **Roles to confirm** view. Pick a row,
   and move its label from **Proposed Roles** to **SVBC Roles** (add it to one, remove it from the
   other). Within about ten minutes the person appears in **Contacts** on the matching opportunity
   (**Sponsorship** for Sponsorships via Sponsor, **Grants** for Grants & Contracts via Funder,
   **Donation Matching** for Donations via Matched By).
3. **A Former contact does not appear.** Set the affiliation from step 1 to **Former**. Within
   about ten minutes the person should disappear from **Contacts**.
4. **A proposal alone does not appear.** Add a role only to **Proposed Roles** on a Current
   affiliation. That person must **not** appear in **Contacts**.
5. **A second contact.** Give another Current affiliation at the same organization the same role;
   both people should be listed.

## Don't report these

* **Contacts** taking up to ten minutes (a little longer for a very large first run).
* Typing in **Contacts** being undone on the next run, by design.
* Boards other than Sponsorships, Grants & Contracts and Donations having no **Contacts** yet;
  they switch on when they gain an Organization link.
* An opportunity with no organization having no contacts.
