# UAT script: public events widget and committee calendars

**Status 2026-10-06: live in production.** This is the one Worker here unrelated to the
migration: it serves bikesiliconvalley.org directly and has been live since August. A five-minute
smoke check is all that's needed, and anything you find is a real production issue.

## What it does

Powers the upcoming-events widget on the SVBC website from Eventbrite, and publishes calendar
feeds anyone can subscribe to: SVBC's public events and volunteer opportunities, plus the meeting
schedules of seven local bicycle and pedestrian advisory committees (Santa Clara, San José,
Cupertino, Campbell, Saratoga, BART, and Caltrain's BATAC), scraped from each agency's site.

## Try it

1. Open <https://events.bikesiliconvalley.org/widget>. Do the listed events match what's on
   SVBC's Eventbrite page right now? A new or edited Eventbrite event shows within 15 minutes.
2. Open <https://committees.bikesiliconvalley.org/calendars>. Pick a committee and open its
   `.ics` link; subscribe to it from your calendar app if you like. Does the next meeting date
   match the agency's own site? Committee feeds refresh within 24 hours.
3. Open <https://committees.bikesiliconvalley.org/status.json>. Every feed should show
   `consecutiveFailures: 0` and a recent `lastSuccessAt`. A feed whose source site is down shows
   a rising failure count while its `.ics` keeps serving the last good copy.

## Don't report these

- A committee meeting the agency posted in the last day may not be in the feed yet.
- If an agency's website is unreachable the feed keeps serving yesterday's copy; that is the
  intended fallback, not staleness.

---

*Engineers: [`svbc-calendars/README.md`](../../svbc-calendars/README.md).*
