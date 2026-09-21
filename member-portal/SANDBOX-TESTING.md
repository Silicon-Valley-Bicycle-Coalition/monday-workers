# Testing the member portal in the sandbox environment

This is a walkthrough for using and testing `svbc-member-portal-sandbox` — the permanent,
already-deployed parallel copy of the member portal that runs against Monday's **CRM Sandbox**
workspace instead of production. It's for anyone testing the portal (staff exercising the real
login flow, an engineer verifying a config or code change) without touching a real donor's data
or inbox. For provisioning the sandbox from scratch, see [`DEPLOY.md`](DEPLOY.md)'s "Sandbox
environment" section — this doc assumes that's already done, which it is.

Background/design: [`../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md`](../docs/superpowers/specs/2026-09-18-sandbox-environment-design.md).

Note on naming: the product is branded "member portal" to donors and staff (the directory,
Worker, and domain all say `member-portal` / `member`), but the underlying Monday data model
still calls people and their records "Donor" — boards, columns, and code all say donor/Donors.
Both terms appear below; they refer to the same thing.

## The one rule: inbound only, no outbound data

The sandbox reads real (if fake-ish) data from Monday's CRM Sandbox boards, but **every email it
sends lands only at `sandbox@bikesiliconvalley.org`** (a Google Workspace group), never at a real
donor's address — no matter which donor's email you type into the login form. This is enforced
twice, independently:

1. **Platform layer:** the Worker's `EMAIL` binding is configured with
   `allowed_destination_addresses: ["sandbox@bikesiliconvalley.org"]`. Cloudflare rejects any
   other recipient outright (`E_RECIPIENT_NOT_ALLOWED`).
2. **Code layer:** `src/email/sandboxBinding.ts` rewrites the recipient to the sink regardless,
   prefixes the subject with `[sandbox → <the address you actually entered>]`, and prepends a
   "Sandbox copy" notice to the body.

Either layer alone would stop a real send; both exist so one bug in the other can't cause a leak.
This is why you can safely type in *any real donor's* email address while testing — you'll never
actually contact that person.

## Quick start — request a real login as a test donor

1. Go to **https://member.sandbox.bikesiliconvalley.org**.
2. Enter the email address of anyone who exists on the CRM Sandbox's People board (Monday board
   `18428131737`, workspace `17141226` — this is the sandbox's equivalent of the production
   Donors board). You need Monday access to browse that board and pick a real entry; any staff
   member testing the portal already has an entry there too.
3. Check the **`sandbox@bikesiliconvalley.org`** group inbox. The login email arrives there with
   subject `[sandbox → <the email you entered>] Your SVBC member portal login link` — never at
   the address you typed.
4. Click the link. The portal renders that donor's real sandbox data: donation history,
   membership status/tier, and any bike-shop discounts.
5. If nothing arrives, you're probably rate-limited (see [Gotchas](#gotchas) below), not broken.

Nothing you do here can write back to Monday except submitting a change request (below) — the
portal is read-only against donor records everywhere else.

## What you can and can't test right now

The sandbox shares the exact same feature gates as production — a feature only appears once its
Monday board/column ids are filled in `config/sandbox.json`. Some features have real sandbox ids
today; others are still placeholders, so they're gated off in the sandbox exactly as they are in
production.

| Feature | Status in sandbox | Why |
|---|---|---|
| Login / magic link | ✅ works | core path, always configured |
| Donation history | ✅ visible | `historyVisibleFromISO` is already past |
| Membership status/tier + bike-shop discounts | ✅ works | two sandbox Organizations items have a discount marked active, for a real result to check |
| Digital membership card (`/portal/card/:id`) | ✅ works | `membershipExpiry` column configured |
| Change requests (address/email/phone edits) | ✅ works, lands on a real sandbox Change Requests board (`18431948024`) | fully configured |
| Tax letters (`/portal/letters`) | ✅ renders, but every letter is stamped **"SANDBOX TEST — NOT A VALID TAX RECEIPT"** | sandbox uses obviously-fake signoff text so the flow can be tested *ahead of* SVBC's real IRS-language sign-off (production's `benefitStatement` is still a placeholder, so letters aren't live there yet) |
| Staff-triggered / automatic January letter-ready emails | ⚠️ machinery is wired up, but leave the "Auto-send" checkbox **unchecked** on the sandbox "Member Portal Letter Settings (sandbox)" board (`18428114991`) — checking it with a past start date queues up to 200 real-looking emails into `sandbox@` on the next 09:00 UTC run | see `DEPLOY.md` |
| Communication preferences (email/SMS opt-out, do-not-mail) | ❌ not shown | opt-out column ids are still placeholders |
| Preferred-language (stored per donor) | ❌ not read | column id is a placeholder; locale still falls back to the browser/cookie guess |
| Volunteer history | ❌ not shown | no sandbox Volunteers board configured |
| Event registrations | ❌ not shown | no sandbox Event Registrations board configured |
| Pledge tracking | ❌ not shown | no sandbox Pledges board configured |
| Employer matching-gifts search widget | ❌ hidden (the page itself still renders, with generic "ask your HR team" guidance and SVBC's real EIN) | no Double the Donation key configured |

If you're testing a feature from the ❌ list, it's not broken — it just has no sandbox board wired
up yet. Ask before spending time debugging a "missing" feature from that list.

## Feature walkthroughs

- **Donations & membership:** log in as above; the portal home page lists donation history and
  current membership tier read live from the sandbox Donations/Donors boards.
- **Discounts:** two Organizations in the sandbox have `Discount Active` checked — log in as a
  donor and confirm both appear with their discount text.
- **Change requests:** from the logged-in portal, submit an address/email/phone change. Confirm
  a new item appears on the sandbox Change Requests board (`18431948024`) with the donor link,
  field, old/new value, and timestamp. Submitting the identical request again within 72 hours
  should be deduped, not double-posted.
- **Tax letters:** visit `/en/portal/letters` while logged in as a donor with at least one gift in
  a completed calendar year. The rendered letter must visibly say "SANDBOX TEST" — if it doesn't,
  something is misreading `config/svbc.json` instead of `config/sandbox.json` and needs
  investigating immediately (it would mean production text leaked into a test artifact, or worse).
- **Shared-email household:** log in with an email that matches more than one sandbox donor item;
  confirm each person renders under their own labeled name, not merged or defaulting to one.
- **Enumeration guard:** request a login for an email that doesn't exist on the sandbox board;
  the response must be byte-identical to a real "check your email" response.

## Gotchas

- **Rate limits are real in the sandbox too.** Login is capped at 5 attempts per email per 15
  minutes (`config/sandbox.json`'s `rateLimit`) plus a 10-requests/60s-per-IP edge limiter. A
  rate-limited request returns the exact same "check your email" response as a real send, by
  design (anti-enumeration) — so repeatedly retesting the same email can silently stop producing
  emails with no error. Wait out the window or use a different sandbox donor's email.
- **`/` is always the login form**, even when you're logged in — the authenticated page is
  `/:locale/portal` (e.g. `/en/portal`), which is where the magic-link callback redirects you.
- **Locale can look "wrong" but isn't** — it's driven by each donor's `Preferred Language` where
  configured, or otherwise your browser's language/cookie, not anything you choose at login.

## Three different ways to run this — don't mix them up

| | Command | Talks to | Needs secrets? | Use for |
|---|---|---|---|---|
| **Sandbox (live, deployed)** | n/a — just browse to `https://member.sandbox.bikesiliconvalley.org` | real CRM Sandbox boards + `sandbox@` inbox | no (already deployed) | the walkthroughs above; the closest thing to "real" testing that's still 100% safe |
| **Local dev against the sandbox** | `npm run dev:sandbox` (`wrangler dev --env sandbox`) | real CRM Sandbox boards + `sandbox@` inbox, but from your machine | yes — the sandbox integration user's `MONDAY_API_TOKEN` and `LETTER_WEBHOOK_SECRET` in `.dev.vars` | debugging a code change against real sandbox data before deploying it |
| **Local dev with fakes** | `npm run dev:local`, or the driver at `.claude/skills/run-member-portal/smoke.sh` | nothing — in-memory fake Monday client and fake email, no network at all | no | fast iteration on UI/logic; three canned fake donors (`jordan@example.com`, `family@example.com` — a two-person household, `casey@example.com`) |

`npm run dev` (no suffix) is **production** — don't use it for testing; it needs real production
secrets and, once those exist, would write to production sinks.

The `run-member-portal` skill (`.claude/skills/run-member-portal/`) documents the fakes-based
local path in detail, including a `smoke.sh demo` one-liner that logs in and prints what it found.

## Automated checks

From `member-portal/`:

```sh
npm test              # ~590 tests, includes config/split.test.ts
npm run typecheck
```

`config/split.test.ts` is the one worth knowing about here: it fails the build if
`config/svbc.json` (production) and `config/sandbox.json` (sandbox) ever end up sharing a board
id, column id, or email sink — the thing that would turn a "sandbox" test into a real write or a
real donor email.

## Deploying a change to the sandbox

```sh
npm test && npm run typecheck
npm run deploy:sandbox
```

This deploys `svbc-member-portal-sandbox` independently of production — deploying to the sandbox
never touches the production Worker, and vice versa. After deploying, redo the quick-start login
above to confirm the change works end to end against real (sandbox) data before it goes anywhere
near production.

## Confirming the safety rule holds (do this after any change to email code)

1. Log in as in the quick start; confirm the email lands **only** in `sandbox@`, with the
   `[sandbox → ...]` subject prefix.
2. `wrangler tail --env sandbox` should show one `{"sandboxOutbound":"email",...}` log line per
   send.
3. See `DEPLOY.md`'s "Sandbox environment" section, step 3, for how to test the platform-layer
   guard in isolation (temporarily bypassing the code-layer wrapper to confirm Cloudflare's
   `allowed_destination_addresses` rejects the send on its own).
