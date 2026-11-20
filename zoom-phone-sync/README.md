# zoom-phone-sync

**Status: ingest built, not deployed.** The webhook route, signature check, ingest filter and D1
dedupe are in (#52). Not yet: the queue consumer that writes Monday (#54), the nightly phone index
and matching (#53), real payload fixtures (#50), and the D1 databases and queues themselves (#55).

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

## What's built (#52)

* `POST /webhooks/zoom` (`src/webhook/route.ts`): verifies `x-zm-signature` with
  `crypto.subtle.verify` (constant time) and rejects timestamps more than 5 minutes off, both with
  401, before anything else, the `endpoint.url_validation` answer included (an unsigned one would
  be an HMAC oracle for forging signatures). A signed delivery skips the per-IP rate limiter.
* Ingest filter (`src/webhook/parse.ts`): drops internal calls, staff lines outside
  `zoom.includeUsers` or in `zoom.excludeUsers` (matched by Zoom user id, email or extension),
  events with no external E.164 number, and other Zoom accounts when `zoom.accountId` is set.
  Each event is rebuilt from named fields, so the SMS `message`, `recording_id` and `voicemail_id`
  never reach D1, the queue or a log.
* D1 migration `0001`: `phone_events` (plus `call_id`, `received_at` and `enqueued_at` beyond the
  design: `call_id` lets the consumer group a call's elements, `enqueued_at` lets a redelivery
  re-enqueue a row whose first send failed), `phone_event_items`, `phone_index`.
* Queue messages carry only `{ eventId }` and the write-switch stamp. Logs are counts and event
  names only; `src/webhook/route.test.ts` checks no number, name or text reaches one.
* Test fixtures in `test/fixtures/` are **synthetic** until #50 captures real deliveries; the
  parser accepts both flat (`caller_did_number`) and nested (`caller.did_number`) call fields
  meanwhile.

Before the first deploy (#55): `wrangler d1 create svbc-zoom-phone-sync` (and `-sandbox`), put the
ids in `wrangler.jsonc`, `wrangler queues create zoom-phone-sync-writes` (and `-sandbox`), set
`ZOOM_WEBHOOK_SECRET`, fill `zoom.accountId` and the sandbox's `zoom.includeUsers`, and add
`"sandbox": {}` to the Worker's entry in `.github/workers.json` so CI deploys it.

```sh
npm test
npm run typecheck
```
