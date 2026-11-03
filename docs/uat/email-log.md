# UAT script: Logging an email to Monday

**Status 2026-11-02: nothing to test yet.** The integration is built but not running anywhere:
the sandbox has no Activities (Logged) board yet, and the logging address doesn't receive mail.
This script will be updated when it is live in the sandbox.

## What it does

In Salesforce you logged an important email with the Gmail side panel. Monday has nothing like
that, so this integration brings back a logging address instead: **BCC an email you send, or
forward one you received, to one address, and it becomes an item on the Activities (Logged)
board, linked to the person it was with.**

- **An email you send:** BCC the logging address (a new message or a reply). Don't put it in To
  or Cc.
- **An email you received:** forward it to the same address.

Log **significant touches only**, the same rule as today. The address makes logging one email
cheap; it doesn't change what is worth logging.

You hear back only when something needs you: a short reply listing any address that isn't on
anyone's record, with a link to the item. A clean log is silent. Mail with nobody outside SVBC on
it (staff to staff) is dropped without a reply.

In the sandbox the address is `log-sandbox@log.bikesiliconvalley.org`, and every reply lands in
the shared `sandbox@bikesiliconvalley.org` inbox rather than yours.

## Try it (once it is live in the sandbox)

Use a personal address you control as the "outside" person: add it to a test person on People
(sandbox) first. Never email a real donor for a test.

1. **A BCC.** Send an email from your SVBC Gmail to that address, BCC the logging address. Within
   a minute, Activities (Logged) should have a new item named after the subject: Activity Type
   **Email**, Status **Done**, today's date, **Owner** you, **Person** linked to the right People
   item, and the message text in **Notes**. Open the person's item card: the activity shows there
   too. No reply should arrive.
2. **A forward.** Forward an email you *received* from that address to the logging address. The
   item should carry the original message's date and subject (without `Fwd:`), and link the
   person who wrote to you, not you.
3. **An unknown address.** BCC the logging address on an email to someone not in Monday. You
   should still get an item, with Status **Needs Person** and no Person link, and a reply (in the
   sandbox inbox) naming the address and linking the item. Link the right person by hand, or add
   the address to their record. Is the reply clear about what to do?
4. **The same email twice.** Forward the email from step 2 to the logging address again. No
   second item should appear, and no reply.
5. **Staff only.** BCC the logging address on an email to a colleague and nobody else. Nothing
   should appear and no reply should come.

## Don't report these

- **Attachments aren't copied to Monday.** Their filenames are listed at the end of Notes.
- **Long emails are cut.** Notes keep about the first 1,900 characters and end
  `… [truncated]`. Quoted history below Gmail's "On … wrote:" line is left off.
- **Only Gmail's forward format is read.** A forward from another mail program becomes a
  `Needs Person` item with a reply saying no outside address was found.
- **BCC plus a forward of the same email makes two items.** Use one or the other; delete the
  extra.
- **A person is matched by email address only,** never by name. An address on nobody's record is
  reported, never turned into a new person.

---

*Engineers: [`email-log/README.md`](../../email-log/README.md) has the matching rules, the dedupe
key, and the sandbox bring-up (board, D1, Email Routing and four live checks) that has to happen
before this script can be run.*
