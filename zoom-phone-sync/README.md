# zoom-phone-sync

**Status: requirements only. The Worker isn't built yet, and its design has open decisions.**

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

Open before building: whether to log text content, telling staff, shared household numbers, which
Zoom lines are included, and how many People have a phone number at all.
