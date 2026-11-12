# Organizer Email Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zachary's BCC'd organizer email logs on the organizer's Affiliation (and so reaches the
Person and the Organization), and an Organization's shared address logs on the Organization.

**Architecture:** No code. Monday board setup (one new column, two Emails & Activities item
views), one live test with a connected mailbox, then staff docs in `monday-migration` and a
superseded note on the old `email-log` spec here.

**Tech Stack:** Monday CRM Emails & Activities, the Monday API (column creation, user lookup),
Claude in Chrome for UI-only steps, Markdown docs.

**Spec:** `docs/superpowers/specs/2026-11-12-organizer-email-logging-design.md`

## Global Constraints

- Boards (Donors & Contacts workspace `18201685`): Organizations `18437909779`, Affiliations
  `18437909787` (Work Email `email_mm8ndy69`), People `18437909781`, People (Historical)
  `18437909784`. Sandbox Organizations `18437342579`, sandbox Affiliations `18437342615`.
- Sandbox first, then production, for every board change.
- New Organizations column: title `Email`, type `email`, description "Shared address for the
  organization (events@, info@). Emails & Activities logs mail to or from it here. A person's
  work address goes on their Affiliation, not here."
- Never create a Person from email; never match by domain.
- Claude sends no email. The live BCC test is sent by David or Zachary.
- Staff doc wording keeps the rule "significant touches only"; never suggest BCCing everything.
- `monday-migration` edits go in a new worktree `../monday-migration-organizer-email` on
  `docs/organizer-email-logging`, not the primary checkout.

## Review Focus

1. **An address on both a People item and an Affiliation** (personal and work email are the
   same). Expected: documented behavior, whichever Monday does. Task 3 records it.
2. **A Draft or Former affiliation holds the Work Email.** Expected: the message still logs
   there; staff read Status on the affiliation. Task 3 checks one Former affiliation.
3. **Zachary has no CRM seat.** Expected: Task 1 stops and asks David before adding a seat
   (billing).
4. **The Emails & Activities view can't be added to Affiliations or Organizations.** Expected:
   Task 2 stops and reports back; the design falls back to People only.
5. **The `Email` column title collides with a marker or an existing column.** Expected: Task 2
   finds by `bareTitle` and creates nothing if it exists.

---

### Task 1: Zachary's CRM seat

**Files:** none.

- [ ] **Step 1:** Look up Zachary Kearsley's Monday user (`list_users_and_teams`) and read
  which products he's on.
- [ ] **Step 2:** If he has no CRM seat, stop and ask David (seats are billed; 7/10 used at
  cutover). Otherwise record "seat confirmed" in the MR description.

### Task 2: Board setup (sandbox, then production)

**Files:** none (Monday only).

**Produces:** the Organizations `Email` column id for each environment, recorded in `docs/22`
by Task 4.

- [ ] **Step 1:** On sandbox Organizations, list columns and check no column's `bareTitle` is
  `Email`. Create it per Global Constraints. Record the id.
- [ ] **Step 2:** In the UI (Claude in Chrome), add the Emails & Activities item view to sandbox
  Affiliations and sandbox Organizations. If the option isn't offered, stop and report (Review
  Focus 4).
- [ ] **Step 3:** Repeat Steps 1–2 on production Organizations `18437909779` and Affiliations
  `18437909787`.
- [ ] **Verify:** `get_board_info` on both production boards shows the `Email` column on
  Organizations; a screenshot of each item card shows the Emails & Activities tab.

### Task 3: Live matching test (David or Zachary sends)

**Files:** none.

- [ ] **Step 1:** Pick (or set up in production, then remove) three test targets using
  addresses the tester controls: an Affiliation with Status `Current` and a Work Email; a
  `Former` affiliation; an Organization with the new `Email` set; one address that is both a
  People Personal Email and an Affiliation Work Email.
- [ ] **Step 2:** The tester, from a Gmail connected to Emails & Activities with the
  BCC-only setting, sends one email to each target, BCC'ing their Emails & Activities address.
- [ ] **Step 3:** Within 15 minutes, record where each message shows (Affiliation, Organization,
  People, or nowhere). Expected: the Affiliation (both statuses) and the Organization each
  show their message. Write down what the shared address does (Review Focus 1).
- [ ] **Step 4:** Remove the test targets and logged entries created for the test.

### Task 4: Staff docs (`monday-migration`)

**Files:**
- Modify: `docs/06-staff-process-guide.md` (§3, "Log an email from a connected Gmail" bullet)
- Modify: `docs/22-board-configuration-plan.md` ("Item card and Emails & Activities")
- Create: `docs/43-logging-organizer-email.md` (how-to for Bike Parking)

- [ ] **Step 1:** In `docs/06` §3, say email now logs on People (Email column), Affiliations
  (Work Email) and Organizations (shared Email), with Task 3's result for an address on two
  boards; and that an Organization's people's mail is one click away through Affiliations.
- [ ] **Step 2:** In `docs/22`, replace "Organizations can follow if staff ask for it" with
  what was added, the date, and #121.
- [ ] **Step 3:** Write `docs/43`: connect Gmail once, pick the BCC-only setting, BCC the
  Emails & Activities address on significant organizer email, put a work address on the
  Affiliation (not People), a shared address on the Organization, and where to look afterwards.
- [ ] **Step 4: Commit** `docs: log organizer email on Affiliations and Organizations (#121)`.

### Task 5: Supersede `email-log` and close out (`monday-workers`)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-19-email-log-design.md` (Status line)
- Modify: `docs/superpowers/plans/2026-10-20-email-log.md` (header note)

- [ ] **Step 1:** Set the spec's status to "superseded 2026-11-04 by Emails & Activities; see
  `2026-11-12-organizer-email-logging-design.md`", and add the same one-line note under the
  plan's title.
- [ ] **Step 2: Commit** `docs(email-log): mark superseded by Emails & Activities (#121)`
  with this plan and the design.
- [ ] **Step 3:** With David's OK, post a comment on #121 summarizing what was set up and
  linking `docs/43`; MR descriptions use "Refs #121", not "Closes".
