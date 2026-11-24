# UAT script: Organization contacts on opportunities (contact-roles)

**Status 2026-11-24: deployed and switched on, in the sandbox and in production.** The sandbox
doesn't run on a schedule (to save cost), so nothing there updates by itself: make your change,
then ask for a run on IT Requests, naming the contact roles sandbox. Production runs every ten
minutes, but has nothing to show until staff confirm the first role in **SVBC Roles**.

## What it does

An opportunity (a sponsorship, a grant, a matched donation) belongs to an organization, and
staff want to see which people there are its contacts. You say who by giving a person a **role**
on their **affiliation** with the organization (for example "Sponsorship" for someone who is a
sponsor contact at Acme). About every ten minutes in production, the **Contacts** column on each opportunity
fills itself in with the people who hold the matching role at that opportunity's organization.
You never edit **Contacts**; it is locked and gets overwritten.

Two role columns live on **Affiliations**: **SVBC Roles** is the confirmed list, and the only one
that counts. **Proposed Roles** holds suggestions made from old data; they do nothing until you
confirm them by moving the label into **SVBC Roles**. Only **Current** affiliations count.

## Try it (sandbox v4)

After each change below, ask for a run on IT Requests and check the result once it's done.

Boards: [Affiliations](https://bikesiliconvalley.monday.com/boards/18437342615),
[Sponsorships](https://bikesiliconvalley.monday.com/boards/18439568033),
[Grants & Contracts](https://bikesiliconvalley.monday.com/boards/18439568066),
[Donations](https://bikesiliconvalley.monday.com/boards/18437342657).

1. **Add a role.** On Sponsorships, pick a sponsorship that has a Sponsor and note the
   organization. On Affiliations, find a **Current** affiliation of some person with that
   organization and add **Sponsorship** to **SVBC Roles**. After the run, that person
   should appear in **Contacts** on the sponsorship.
2. **Confirm a proposed role.** On Affiliations, pick a row with a label in **Proposed Roles** (the
   sandbox has no **Roles to confirm** view yet, so filter on that column), and move its label from **Proposed Roles** to **SVBC Roles** (add it to one, remove it from the
   other). After the run, the person appears in **Contacts** on the matching opportunity
   (**Sponsorship** for Sponsorships via Sponsor, **Grants** for Grants & Contracts via Funder,
   **Donation Matching** for Donations via Matched By).
3. **A Former contact does not appear.** Set the affiliation from step 1 to **Former**. After the run,
   the person should disappear from **Contacts**.
4. **A proposal alone does not appear.** Add a role only to **Proposed Roles** on a Current
   affiliation. That person must **not** appear in **Contacts**.
5. **A second contact.** Give another Current affiliation at the same organization the same role;
   both people should be listed.

## Don't report these

* **Contacts** not changing in the sandbox until someone starts a run. In production it takes up to
  ten minutes (a little longer for a very large first run).
* Typing in **Contacts** being undone on the next run, by design.
* Boards other than Sponsorships, Grants & Contracts and Donations having no **Contacts** yet;
  they switch on when they gain an Organization link.
* An opportunity with no organization having no contacts.
* Nothing changing at all while no affiliation has a confirmed role in **SVBC Roles**: the pass
  deliberately leaves **Contacts** alone until at least one role exists.
