# zoom-phone-sync

[Appendix A](../reference/zoom-phone-sync.md) lists this Worker's routes, crons, queues, storage and bindings.

Configured as `svbc-zoom-phone-sync` (production) and `svbc-zoom-phone-sync-sandbox` (sandbox), on
the `workers.dev` host with no custom domain. **Partly built and not deployed:** the webhook ingest
is in (GitHub #52), but the queue consumer that writes Monday (#54) and the nightly phone index
(#53) aren't. The D1 database ids in `wrangler.jsonc` are placeholders, and the queues don't exist
yet. See the root README's [Status at a glance](../../../README.md#status-at-a-glance).

## What it does

It logs Zoom Phone calls and texts between staff and supporters in Monday. Each call or text with
someone on People becomes one entry on that person's Emails & Activities timeline, and a 🔒 Last
Phone Contact date moves. Staff calls and texts don't reach Monday otherwise: Monday CRM's own Zoom
integration covers meetings only.

Texts are logged without their content. Their entry names the staff line and links to Zoom, where
only that line's owner can read the conversation.

## Trigger and data flow

Zoom Phone webhooks from a Server-to-Server OAuth app (one per environment):
`phone.caller_call_element_completed`, `phone.callee_call_element_completed`, `phone.sms_sent` and
`phone.sms_received`. Recordings, voicemail and transcripts are never subscribed.

1. **`POST /webhooks/zoom`** verifies `x-zm-signature` (HMAC-SHA256 of
   `v0:{timestamp}:{body}`, compared in constant time) and rejects timestamps more than 5 minutes
   off, both with 401. This runs before anything else, including the `endpoint.url_validation`
   answer, which Zoom repeats every 72 hours. A signed delivery skips the per-IP rate limiter.
2. **Ingest filter:** drops internal calls, staff lines outside `zoom.includeUsers` or in
   `zoom.excludeUsers`, events with no external phone number, and other Zoom accounts. Each event
   is rebuilt from named fields, so SMS text, `recording_id` and `voicemail_id` are never stored.
3. **D1 dedupe** on `call_element_id` / `message_id` into `phone_events` (status `pending`), then
   enqueue `{ eventId }` on `zoom-phone-sync-writes`. Zoom expects an answer within 3 seconds, so
   nothing else happens in the request.
4. **Queue consumer (#54, not built):** match the number against the D1 `phone_index`, write the
   timeline entry on each matching People item, advance Last Phone Contact, mark `logged`.
5. **Nightly index (#53, not built):** rebuild `phone_index` from People's Phone column normalized
   to E.164, and retry `unmatched` rows younger than 14 days.

## Monday boards and columns

Ids live in `config/svbc.json` (production) and `config/sandbox.json` (CRM Sandbox).

| Board | Reads | Writes |
|---|---|---|
| People | Phone (`people.phoneColumn`) | Timeline entries (custom activities Zoom Phone call / text), 🔒 Last Phone Contact |

The custom activities Zoom Phone call (`ee8aa7f6-37b1-48e5-984a-0e7fbe434d58`) and Zoom Phone text
(`1a24bb64-a468-4d5e-af7b-ba103e24002c`) were created 2026-11-20 (#51). Custom activities are per
Monday account, so both configs name the same ids. Last Phone Contact is `date_mm997y73` on
production People and `date_mm99hywz` on the sandbox's; neither People board has a form view to
hide it from. It never creates a person.

## Secrets

| Name | Purpose | Issued by | Rotate |
|---|---|---|---|
| `ZOOM_WEBHOOK_SECRET` | The Zoom app's webhook secret token: signature check and URL validation. Unset: every delivery gets 401 | Zoom App Marketplace → the S2S app → Feature → Event Subscriptions | Regenerate in Zoom, `npx wrangler secret put ZOOM_WEBHOOK_SECRET` (`--env sandbox`) at once; deliveries fail until both match |

No Zoom client secret: v1 makes no Zoom REST calls. No Monday secret: access comes from the
broker's `SyncToken`.

## Write switch

Key `zoom-phone-sync:writes`. An unset key reads as `off`.

| Mode | Behavior |
|---|---|
| `on` | Live (once the consumer exists). |
| `off` | Ingest still runs; queue messages are stamped `dropped`, so the consumer dry-runs them. |
| `hold` / `unknown` | Ingest still runs; messages stay queued. |

The queue isn't in `scripts/flags.mjs`'s pause list until its consumer exists (#54). See
[Operations](../07-operations.md).

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Log `rejected delivery (signature missing)` | `ZOOM_WEBHOOK_SECRET` unset, or the request isn't from Zoom | Set the secret |
| Log `rejected delivery (signature mismatch)` | Secret differs from the Zoom app's | Copy the secret token again |
| Log `rejected delivery (signature stale)` | Clock skew over 5 minutes, or a replay | Expected for replays |
| Log `ignored … (another Zoom account)` | `zoom.accountId` doesn't match the app | Fix config |
| Every event counted `excluded` in sandbox | `zoom.includeUsers` is `[]` | Add the test line's Zoom user id |
| Log `enqueue failed`, 500 | Queue unavailable | Zoom retries 5xx three times (5, 20, 60 minutes); the row is re-enqueued on redelivery |

Zoom gives up after those three retries, so an ingest outage over about 85 minutes loses events.

## Operator scripts

None yet. `scripts/flags.mjs` sets the write switch.

## Changing it

```sh
cd zoom-phone-sync
npm test
npm run typecheck
```

Test fixtures in `test/fixtures/` are synthetic until #50 captures real deliveries. Logs must stay
counts only: `check-log-safety.mjs` catches email addresses but not phone numbers, so review has to
hold that line. Before the first deploy, follow the checklist at the end of the Worker README.
[CI and deploy](../06-ci-and-deploy.md).

## Further reading

- [zoom-phone-sync/README.md](../../../zoom-phone-sync/README.md): what's built and the pre-deploy checklist.
- [Design](../../../docs/superpowers/specs/2026-11-19-zoom-phone-sync-design.md): matching, timeline entries, privacy decisions.
- [mailchimp-sync](mailchimp-sync.md): the Journey send log, the same timeline-entry mechanics.
- Core chapters: [Architecture](../02-architecture.md), [Operations](../07-operations.md),
  [Troubleshooting](../08-troubleshooting.md)
