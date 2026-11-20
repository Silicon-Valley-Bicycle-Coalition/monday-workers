# zoom-phone-sync

**Status: requirements only. The design is decided (2026-11-19); the Worker isn't built yet.**

Logs Zoom Phone calls and texts between staff and supporters on each supporter's Monday People
item: one Emails & Activities timeline entry per call or text, plus a 🔒 Last Phone Contact date.

Design: [`docs/superpowers/specs/2026-11-19-zoom-phone-sync-design.md`](../docs/superpowers/specs/2026-11-19-zoom-phone-sync-design.md).

Shape, in brief:

* Zoom Phone webhooks (`phone.caller_call_element_completed`, `phone.callee_call_element_completed`,
  `phone.sms_sent`, `phone.sms_received`) → signature check → D1 dedupe → queue → consumer writes
  Monday. Recordings, voicemail and transcripts are never subscribed.
* Matching by phone number through a nightly D1 index of People's Phone column, normalized to
  E.164. Unmatched numbers are retried for 14 days, then deleted. It never creates a person.
* Write switch `zoom-phone-sync:writes`, `sandbox` environment with its own Zoom app limited to a
  test line, Monday access through `monday-auth`'s `SyncToken`.

Decided 2026-11-19: texts are logged without their content, with a link to Zoom; a shared number
logs on each person; every staff line is included; staff are told through the communication-logging
protocol, updated the day production writes go on. Phone coverage, counted 2026-11-19: 59% of
People, 70% of current members.
