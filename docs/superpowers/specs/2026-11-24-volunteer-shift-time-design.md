# Shift time on volunteer sign-ups (Volunteers board)

Status: approved 2026-11-24. Date: 2026-11-24. Size: small change. Issue #5, answer 2.

## Why

Bike Parking lists one event's shifts as separate Eventbrite listings with the same name and date (2026-06-13:
8:00 AM–12:00 PM and 12:00–4:00 PM). Zachary wants them as one group on the Volunteers board. Since
2026-11-24 **Upcoming by event** and **Completed by event** do that, because their `2026-06-13 · <name>`
heading is the same for both. What a merged section doesn't show is who is on which shift: **Shift** holds
the ticket name, usually the same on both listings.

Counted 2026-11-24 in production: 27 such pairs, 19 with sign-ups on both. Five compared in Eventbrite: all
were separate shifts of one series.

## Goals, non-goals, anti-goals

- Goal: every Eventbrite sign-up shows its listing's start and end time, in the views staff use.
- Non-goals: re-pointing Event, merging Events items, hours worked (its own issue), grouping Recent events.
- Anti-goals: changing an Event link, a Shift Lead or a status; writing a time nobody can trust.

## Approaches

| | Approach | Outcome |
|---|---|---|
| A | Keep the events separate, add the shift time | **Picked** (David, 2026-11-24). No Event link changes; each shift keeps its lead and length. |
| B | Also re-point Event to one shared item | One Volunteers list and one lead per day on Events, but needs a which-listing-wins rule, must not undo staff's re-pointing, moves 69 rows. Can be added later. |
| | Merge the Events items | Breaks one listing per item, which the sync and Send event email rely on. |
| | A mirror or formula, no code | Events stores dates without times, so there is nothing to mirror. |

## Design

- **Column:** `🔒 Shift Time`, text, on Volunteers; added to `MARKED_COLUMNS`. The sync overwrites edits.
- **Config:** `attendeeSync.volunteers.shiftTimeColumn`, optional like `ticketTypeColumn`: the placeholder
  writes nothing, so a deploy can precede the column.
- **Value:** from the listing's Eventbrite start and end, in Pacific time, written by `mapVolunteer` on every
  delivery: `8:00 AM–12:00 PM`.

  | Listing | Shift Time |
  |---|---|
  | Ends within 24 hours, past midnight included | `8:00 PM–12:30 AM` |
  | Longer than 24 hours | `Oct 3, 8:00 AM–Oct 4, 12:00 PM` |
  | No end, or an end at or before the start | `8:00 AM` |
  | No start | not written; an earlier value stays |

- **Views:** `setup-volunteers-board.mjs` creates the column and puts it after Shift in a newly created
  Upcoming by event. The existing production views get it by hand, since the script doesn't edit views:
  Upcoming by event, Completed by event, Recent events.
- **Which listing:** always the row's own Eventbrite listing, even if staff re-point Event.

## Known limits

- Text sorts as text, so `12:00 PM` sorts before `8:00 AM`. Sections stay sorted by Shift.
- A time changed in Eventbrite reaches a row on that attendee's next delivery or a replay, as Date does.
- A listing with several shifts as ticket types shows the whole listing's time; Shift names the part.

## Rollout

Sandbox v4 first: column, deploy, replay one pair with `backfill-attendees.mjs`, look at the view. Then
production after the operator's go-ahead: column, config, deploy, then replay upcoming listings and the 54
listings in the 27 pairs. No email is sent by any step.

Another branch (`claude/custom-questions-monday-automation-c10541`) edits `config.ts`, `types.ts`, both
configs and `testConfig.ts`; expect small conflicts with whichever lands second.

## Left to the builder

Formatter name and file, test layout, column id.
