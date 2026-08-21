# gemini-reports

**Status:** Recommended.
**Priority:** Post-migration, non-blocking.
**Owner:** Unassigned.
**Stack:** Hono + TypeScript.

## The ask

The team is hitting Monday.com's AI token/credit limits. SVBC has free/discounted Gemini access
via Google for Nonprofits — can Gemini be swapped in for Monday's AI, or used for report
generation instead?

## Why this can't just be a Monday setting

Monday's native AI (AI Blocks, Sidekick, Notetaker, Agents, AI Workflows) all run on Monday's own
metered **AI Credits** system — confirmed via
[Monday's own AI Credits documentation](https://support.monday.com/hc/en-us/articles/29544502265746-AI-Credits).
There's no documented way to point any of them at Gemini or another model. Running out of credits
means buying more or throttling; that's not fixable from outside Monday.

## Why SVBC's existing Gemini access doesn't directly help

[Google for Nonprofits](https://www.google.com/nonprofits/about/program-overview/) gives Workspace
for Nonprofits "access to Gemini and NotebookLM... within Google Docs, Calendar, Meet, Sheets,
Forms, and Slides" — that's the in-app Gemini side panel, not a callable API. It can't be reached
from a Worker.

## What actually works

The **standalone Gemini API has its own free tier**, unrelated to the nonprofit Workspace grant —
[Google AI Studio](https://ai.google.dev/gemini-api/docs/billing) issues a free API key with no
billing account and no nonprofit status required. Same acquisition pattern as every other free-tier
API used elsewhere in this plan — **but see the privacy constraint below before treating "free
tier" as the decision.**

## Privacy constraint: the free tier trains on your data

Google's terms for the *unpaid* Gemini API tier allow submitted content to be used for product
improvement, including human review. **Donor- or contact-identifiable board data must not be sent
through a free-tier key.** Two acceptable shapes:

* **Paid tier** for any report touching donor data — paid Gemini API terms exclude training on
  customer content, and per-request cost at SVBC's report volume is small.
* **Free tier restricted to aggregate, non-identifiable inputs** — counts, totals, status
  rollups, with names/emails/addresses stripped before the request is built, not after.

This is the one place in the plan where build-over-subscription could quietly trade donor privacy
for $0 — don't let it. Verify the current data-use terms at build time; Google has changed them
before.

## Data flow

```
Monday.com GraphQL API (ordinary, non-AI-metered — same API every other Worker here already uses)
  │  read board/report data
  ▼
Cloudflare Worker
  │  sends data to Gemini API for summarization / report generation
  ▼
writes the result back into Monday.com
  as a Doc, an Update, or a Dashboard field
```

This sidesteps Monday's AI credit ceiling entirely rather than trying to raise it — the read side
never touches Monday's metered AI endpoints at all.

## Open questions

* Which specific reports are hitting the token limit today, and what's their actual input size?
  Needed to size the Gemini free-tier rate limits against real usage before committing to "free
  tier is enough."
* Which data classes do those reports contain? Anything donor- or contact-identifiable forces the
  paid tier or pre-send redaction — see the privacy constraint above. This question decides the
  build's shape, not just its cost.
* Where should output land — a monday Doc (full rich text, matches the Board Documentation
  Conventions pattern elsewhere in the plan), an Update, or a Dashboard field? Doc is likely the
  best fit for a full report; a Dashboard field for a short recurring summary.

## Sources

* [Monday.com — AI Credits](https://support.monday.com/hc/en-us/articles/29544502265746-AI-Credits)
* [Google for Nonprofits — program overview](https://www.google.com/nonprofits/about/program-overview/)
* [Gemini API billing & free tier — Google AI for Developers](https://ai.google.dev/gemini-api/docs/billing)
* Plan section: Gemini reporting (Integrations) — `migration-plan.md` (private planning repo)
