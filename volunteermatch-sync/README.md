# volunteermatch-sync

**Status:** Recommended, pending confirmed terms — do not start the build until Idealist confirms
access and cost.
**Priority:** Post-migration, non-blocking.
**Owner:** dwk — confirms API access/terms with Idealist first; build the sync once confirmed.
**Stack:** Hono + TypeScript, same shape as the other syncs in this plan.

## The ask

Broaden volunteer recruitment beyond SVBC's own site by syndicating open roles to a larger
network.

## Status of the API

[VolunteerMatch](https://developers.volunteermatch.org/api-docs) is now part of
[Idealist](https://solutions.volunteermatch.org/product/api). **Cost and access terms are not yet
confirmed** — this is the actual blocker, not a technical one. Check directly with Idealist before
committing to any build work.

## Data flow (once terms are confirmed)

```
Monday board (open volunteer roles)
  ▼
Cloudflare Worker
  │  pulls open roles from the board
  ▼
VolunteerMatch / Idealist API
  │  pushes roles out to the network
```

Same shape as every other outbound sync in this plan — nothing unusual here once access terms are
known. The open item is entirely "can we get in and what does it cost," not "how would this be
built."

## Sources

* [VolunteerMatch API](https://developers.volunteermatch.org/api-docs)
* [VolunteerMatch / Idealist API product page](https://solutions.volunteermatch.org/product/api)
* Plan section: VolunteerMatch / Idealist (Integrations) — `migration-plan.md` (private planning repo)
