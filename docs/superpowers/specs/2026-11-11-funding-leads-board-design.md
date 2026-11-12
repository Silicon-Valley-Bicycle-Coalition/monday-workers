# Funding Leads board (solicitation pipeline) — design

Status: draft for approval. Build target: **sandbox only** (CRM Sandbox v4, workspace 18210301).

## Intent

SVBC solicits money from many kinds of funders. Today that lives in a Google Sheet
("2027 Sponsor List": per-event sponsor tabs, a ~230-row Prospects tab, a ~90-row Lapsed
Donors tab, and a 2011–2026 Salesforce opportunity export) whose only progress marker is a
"Scheduled Meeting" checkbox. Clarrissa liked the stage bar and Awarded/Lost card on
Monday CRM's Leads and Deals boards, and two sandbox test boards ("Grants & Contracts" 18438893957,
"Sponsorships" 18438893959) prove a regular board in a CRM workspace can have both.

Build **one Leads board for all funding solicitations, tagged by type**, that tracks the
solicitation up to a yes. A pledged lead becomes an **Opportunity** (a `Deals` item), where
the contract, details and payments are worked out. Events and Tasks are created and tracked
from the Opportunity.

## Goals

- One place to see every open solicitation, filterable by type, event, owner and stage.
- A Stage bar ending at **Pledged** (the hand-off) with **Lost** kept as history, so lapsed
  funders stay findable for the next cycle.
- A one-step hand-off: Pledged produces a linked Deals item carrying the lead's data.
- Seed Leads from the sponsor sheet so staff start with real prospects.

## Non-goals

- Contracts, payments, invoices, PO numbers: these belong to the Opportunity (Deals), not Leads.
- Building the Events and Tasks boards. Leads/Deals only link to them; the existing event
  pipeline boards (workspace 13489605) are the likely home and are out of scope to restructure.
- Production rollout. Nothing here touches the production CRM workspace (10001654) or its
  stock Leads board (8531259839). Promotion to production is a separate, later decision.
- Importing the 2011–2026 raw Salesforce export (history lives in the salesforce-import data).

## Anti-goals (failure even if it technically works)

- A deal that spans several events (BTWD + Summit + Ride is common) gets split into one item
  per event, losing the single commitment.
- Invoice/PO placeholder columns reappear on Leads.
- Anything in the sandbox is written to production boards or partner columns
  (see the `monday-duplicate-board-side-effects` caution: copying a board can touch production).

## Decisions made with the user

1. One board, all funding opportunities, tagged by a **Type** column.
2. Leads tracks solicitation only; **Pledged** is the hand-off stage (not Awarded).
3. **Hybrid** destination: `Deals` is the Opportunity record; Events and Tasks live on linked
   boards (event pipeline boards where they fit), not as the destination of the hand-off.
4. Build in the **sandbox** first.
5. A regular board (not a native CRM board type) is acceptable: the test boards gave Clarrissa the
   stage bar and Awarded/Lost card she liked. Leads and Deals are built as regular boards.
6. **Type is multi-select**, so the Deal's Type and any contact-role mapping handle several values.

## Proposed design (builder's calls marked)

**Leads board columns** (call: modeled on the test boards' column set)
- Name, Organization (board_relation to the sandbox Organizations board 18437342579),
  Contact (board_relation), Amount, Owner (people), Expected Close (date).
- **Type** (dropdown, **multi-select**; user decision): Grant, Contract, Sponsorship. A lead can
  carry several (e.g. Grant + Sponsorship). Values are a call; extend if the team distinguishes more.
- **Events of interest** (dropdown, multi): BTWD, Advocacy Summit, Dinner, Fundraising Ride,
  Wellness, Misc. One lead can name several.
- **BTWD tier** (status: Local, Regional) — call, from the sheet's Type column.
- **Funder Status** (New, Renewal, Lapsed) — carried from the test boards.
- **Stage** (status): Research, Needs Cultivation, Cultivation, Scheduled Meeting, LOI/Proposal
  Submitted, Evaluation, **Pledged** (done), **Lost**. Final labels are a call; Pledged and Lost
  must exist, Pledged marked done.
- Views: Open (Stage not Pledged/Lost), Pledged, Lost.

**Hand-off** (call: a button column + automation, mirroring the stock "Move to Contacts")
- Pledged (or a "Convert to Opportunity" button) creates a `Deals` item carrying Organization,
  Contact, Amount, Owner, Type and Events of interest, and links back to the lead.
- The Deals board gets matching columns (Type, Events, contract/payment/invoice fields).
  Whether to extend the sandbox copy of Deals or build a fresh Opportunities board is left to
  the builder after inspecting what the sandbox has.

**Seed data** (call)
- Active 2026–27 tab and Prospects tab → Leads items (Organization matched or created).
- Lapsed Donors tab → Leads items with Stage Lost and Funder Status Lapsed.
- Multi-event "Sponsorship Cycle" strings ("2024 BTWD; 2024 Advocacy Summit; …") map to Events of
  interest, not to multiple items.

## Calls made after the builder check (author's calls, not user decisions)

- **Hand-off is one-shot and idempotent.** The lead stays on Leads as Pledged history (it is not
  moved or archived). The Deal link column is the dedupe key: conversion runs only when it is
  empty. Moving Stage out of Pledged and back never creates a second Deal.
- **Events field:** a multi-select dropdown on both Leads and Deals (same values). Linking a Deal
  to items on the event pipeline boards happens later, when Events/Tasks are created; it is not
  part of this build.
- **Boards are built fresh, never duplicated** (`duplicate_board` can touch production partner
  columns). The sandbox Deals board is extended if it exists, otherwise a regular Opportunities
  board is created.
- **Organization/Contact links** are plain board_relations to the sandbox Organizations board
  now. If the Affiliations role work later needs different targets, re-point them; the sandbox
  data is disposable.
- **Seed load** is a throwaway operator script run from `monday-migration` (data and ledger
  gitignored there; no donor PII in this repo). The sheet is read through the Drive connector.
  Organizations match on exact normalized name; near-matches are written to a review file, not
  merged. Contacts are filled from the sheet where present, else left empty.
- **Sheet mapping:** checked "Scheduled Meeting" → Stage Scheduled Meeting; Prospects tab →
  Needs Cultivation; other active rows → Research; Lapsed Donors → Lost + Funder Status Lapsed.
  Sponsors with no Local/Regional value leave BTWD tier empty.
- **Sandbox safety:** every script hard-codes a workspace-id guard (18210301) and refuses
  anything else; the builder confirms the Sandbox Integration token cannot write to 10001654.

## Constraints

- Sandbox only. Per the repo's sandbox conventions, never write sandbox data to production
  boards; check the Monday workspace id on every call.
- Another session ("Organization contact roles") is adding an SVBC Role dropdown to the
  Affiliations board (18437909787) and wants each opportunity board to list contacts by role.
  Leads' Organization link must be compatible; Type could map to a role (Sponsorship, Grants).
  Not decided; coordinate before finalizing.
- Contact PII from the sheet is real donor data: do not commit it to the repo.

## Left to the builder

Exact Stage labels and colors, final Type values, column ids, how the hand-off automation is
implemented (native Monday automation vs a Worker), and whether Deals is extended or replaced.
