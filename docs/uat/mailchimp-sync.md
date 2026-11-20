# UAT script: Mailchimp sync

**Status 2026-09-30: testable now**, against a Mailchimp audience named **SVBC Sandbox** that
contains no real subscribers' inboxes in any sense that matters: nothing sends email from it.

## What it does

Keeps each donor's Mailchimp contact in step with their Monday record, so newsletter segments and
the membership email journeys (welcome series, renewal reminders 4 weeks and 2 weeks before
expiration and on the day itself) can key off real membership dates. When a person's membership, address, or Do Not Solicit flag changes on
People, the matching Mailchimp contact's merge fields and tags update within seconds to minutes.
When someone changes their interests or unsubscribes in Mailchimp, their **Mailchimp Campaigns**
column on People updates to match.

Two rules it never breaks: it **never adds anyone to Mailchimp**, and it **never re-subscribes
anyone**. A person who isn't already in the audience is skipped silently.

## Safety

The sandbox copy can only write to the SVBC Sandbox audience, and it does not send campaigns or
journeys; those are staff-built in Mailchimp. Changing a person on the sandbox People board
cannot reach the real SVBC audience.

## Try it

You need a person whose **Personal Email** on
[People (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342592) is also a contact
in the SVBC Sandbox audience. Ask the migration team for one if you don't know which to use.

1. **Monday to Mailchimp.** Change that person's Membership Status, Membership Tier, Member Since,
   or Member Until. In Mailchimp, open the contact in the SVBC Sandbox audience: the merge fields
   MEMBSINCE, MEMBUNTIL, MTIER, and MSTATUS should match, and the tags `active-member`,
   `lapsed-member`, or `lifetime-member` should follow the status and tier. Allow a minute.
2. **Address.** Fill in Address, City, and Zip (State is worked out from the Zip if blank); the
   ADDRESS merge field updates. With Address, City, or Zip blank it is left alone.
3. **Total given.** After a gift rolls up (see [donation rollups](donation-rollups.md)), the
   TOTALGIVE merge field and the `has-donated` tag should reflect Lifetime Giving.
4. **Do Not Solicit.** Check **Do Not Solicit** on the person: the contact gains the
   `do-not-solicit` tag. Then set **DNS Reason Status** to **Confirmed**: the contact is
   **unsubscribed** in Mailchimp. Unchecking the box later removes the tag but does not
   re-subscribe them; that is deliberate.
4a. **Member portal email preference.** Sign in to the sandbox member portal as a person whose
   Personal Email is in the SVBC Sandbox audience. On **Profile → Communication preferences**,
   set Email to **Opted out**: within a minute the contact is **unsubscribed** in Mailchimp, and
   within the hour that person's **Personal Email Consent** reads Unsubscribed. Set it back to
   **Subscribed**: Mailchimp emails that address a confirm link, and the contact shows
   **pending** until the link is clicked. Texts (SMS) and postal mail change the person's **SMS
   Opt-Out** and **Do Not Mail** checkboxes on People instead.
5. **Mailchimp to Monday.** In Mailchimp, change the contact's interests (the groups on their
   profile) or unsubscribe them. Back on People, the person's **Mailchimp Campaigns** column
   should update to list the groups they are now in.
6. **The campaign list.** Add or rename an interest group in the SVBC Sandbox audience. After the
   daily pass (8 am Pacific, 7 am in winter) the
   [Mailchimp Campaigns (sandbox)](https://bikesiliconvalley.monday.com/boards/18439574436) board
   should show the change.
7. **Consent columns.** In the SVBC Sandbox audience, unsubscribe a contact whose address is a
   person's Personal or Household Email on People (sandbox v4), or a Work Email on
   [Affiliations (sandbox v4)](https://bikesiliconvalley.monday.com/boards/18437342615). Within
   the hour (the sync runs at five past), that item's matching **Email Consent** column should
   say **Unsubscribed**. Resubscribing them in Mailchimp turns it back to **Subscribed** the
   same way.

## Don't report these

- A person not already in the audience is skipped; no contact is created. Not a bug.
- Household Email and any second email address are not synced to Mailchimp; only Personal Email
  is. (Their consent columns do still follow Mailchimp, step 7.)
- A consent column on an item with no address is left as it is, and an address Mailchimp has
  archived or no longer holds keeps an Unsubscribed or Cleaned it already had. Both deliberate.
- Editing a consent column by hand doesn't stick: the next hourly run puts Mailchimp's value back.
- If someone changes their email address *in Mailchimp*, the sync skips them until staff update
  Monday to match.
- Only People and People (Historical) are watched, not Organizations.
- A People (Historical) person whose address is also on People doesn't change the Mailchimp
  contact; the People record owns it. The exception is a Confirmed Do Not Solicit, which still
  unsubscribes.
- Editing a person on People (Historical) doesn't update the Campaigns column; that only runs on
  People.
- A Mailchimp unsubscribe does not tick Do Not Solicit on Monday; unsubscribing from email and
  asking not to be solicited are treated as different things.

## Not testable yet

- The welcome and renewal-reminder journeys themselves. Staff build those in Mailchimp off the
  merge fields above; the sync only keeps the fields current.
- Whether the DNS Reason Status column on the sandbox board carries a **Confirmed** label yet.
  If it doesn't, step 4's unsubscribe half can't be tried; say so on IT Requests.

---

*Engineers: [`mailchimp-sync/README.md`](../../mailchimp-sync/README.md) has the field map,
the Do Not Solicit rules, and the dead-letter operations that are still to do.*
