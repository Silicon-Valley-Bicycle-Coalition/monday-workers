import type { ImpactAttributionConfig } from './config';
import type { Environment } from './environment';
import { evidenceComment } from './evidence';
import type { ImpactMondayClient } from './monday/client';
import { qualifyingPairs, selectCandidates, type Candidate } from './rule';
import { allMatches, proposedPairs, recordProposal, refreshMatches, storedIdsNotIn } from './store';

// One nightly run (spec "Schedule and shape"). Logs carry item ids and counts only — never a
// person's name or email. Organization names appear only in the `off` payer summary.

const WORKER = 'impact-attribution';

export interface RunSummary {
  matchesRead: number;
  upserted: number;
  deleted: number;
  qualifying: number;
  skipped: { excluded: number; existing: number; proposed: number; missingItem: number };
  proposed: number;
  failed: number;
  deferred: number;
}

export interface RunDeps {
  monday: ImpactMondayClient;
  db: D1Database;
  config: ImpactAttributionConfig;
  environment: Environment;
  today: string; // YYYY-MM-DD
  now: string; // ISO timestamp
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runProposals(deps: RunDeps, mode: 'on' | 'off'): Promise<RunSummary> {
  const { monday, db, config } = deps;

  const read = await monday.readActiveMatches(config);
  // The read returns only items with a Matched By. A stored match it didn't return is kept when its
  // gift is archived, but deleted when the item is still active: staff cleared its Matched By.
  const returned = new Set([...read.stored.map((m) => m.donationItemId), ...read.rejectedIds]);
  const unreturned = await storedIdsNotIn(db, returned);
  const stillActive = await monday.activeItems(unreturned);
  const cleared = unreturned.filter((id) => stillActive.has(id));
  const { upserted, deleted } = await refreshMatches(db, { stored: read.stored, rejectedIds: [...read.rejectedIds, ...cleared] }, deps.now);

  const qualifying = qualifyingPairs(await allMatches(db), config.rule, deps.today);
  const skips = {
    excludedOrgIds: new Set(config.excludedPayers.map((p) => p.id)),
    existingPairs: await monday.existingAffiliationPairs(config.affiliations),
    proposedPairs: await proposedPairs(db),
  };
  const { chosen: eligible, skipped } = selectCandidates(qualifying, skips, Number.MAX_SAFE_INTEGER);

  // Post-import merges deleted some People and Organizations items; a candidate pointing at one is
  // skipped without taking one of the run's slots, so a stale pair can't block the queue. The same
  // reads supply the names for the Draft and the comment.
  const max = config.maxProposalsPerRun;
  const live: Candidate[] = [];
  const names = new Map<string, string>();
  let checked = 0;
  let missingItem = 0;
  while (live.length < max && checked < eligible.length) {
    const chunk = eligible.slice(checked, checked + (max - live.length));
    checked += chunk.length;
    for (const [id, name] of await monday.activeItems(chunk.flatMap((c) => [c.personItemId, c.orgItemId]))) names.set(id, name);
    for (const c of chunk) {
      if (names.has(c.personItemId) && names.has(c.orgItemId)) {
        live.push(c);
      } else {
        missingItem++;
        console.log(`${WORKER}: candidate ${c.personItemId}/${c.orgItemId} skipped: person or organization item is gone`);
      }
    }
  }
  const summary: RunSummary = {
    matchesRead: read.stored.length + read.rejectedIds.length, upserted, deleted, qualifying: qualifying.length,
    skipped: { ...skipped, missingItem }, proposed: 0, failed: 0, deferred: eligible.length - checked,
  };

  if (mode === 'on') {
    for (const c of live) await propose(deps, c, names, summary);
    console.log(JSON.stringify({ worker: WORKER, environment: deps.environment, mode, ...summary }));
  } else {
    console.log(JSON.stringify({
      worker: WORKER, environment: deps.environment, mode, ...summary,
      wouldPropose: live.map((c) => ({ personItemId: c.personItemId, orgItemId: c.orgItemId, proposedStatus: c.proposedStatus, matches: c.matches.length })),
      payers: await payerSummary(deps, eligible),
    }));
  }
  return summary;
}

async function propose(deps: RunDeps, c: Candidate, names: Map<string, string>, summary: RunSummary): Promise<void> {
  const orgName = names.get(c.orgItemId)!;
  let affiliationItemId: string;
  try {
    affiliationItemId = await deps.monday.createDraft(deps.config.affiliations, {
      name: `${names.get(c.personItemId)!} @ ${orgName}`, personItemId: c.personItemId, orgItemId: c.orgItemId, proposedStatus: c.proposedStatus,
    });
    // Recorded only after Monday confirmed the create (the repo's cursor invariant).
    await recordProposal(deps.db, {
      personItemId: c.personItemId, orgItemId: c.orgItemId, affiliationItemId, proposedStatus: c.proposedStatus, matchCount: c.matches.length,
    }, deps.now);
  } catch (err) {
    summary.failed++;
    console.error(`${WORKER}: proposal ${c.personItemId}/${c.orgItemId} failed: ${errorText(err)}`);
    return;
  }
  summary.proposed++;
  try {
    await deps.monday.postUpdate(affiliationItemId, evidenceComment(orgName, c.matches));
  } catch (err) {
    // The Draft is the proposal; a missing comment doesn't undo it.
    console.error(`${WORKER}: evidence comment on affiliation ${affiliationItemId} failed: ${errorText(err)}`);
  }
}

// Every organization that would get a Draft if there were no per-run cap, for the review that
// builds `excludedPayers` (spec "Rollout"). Excluded payers are already left out.
async function payerSummary(deps: RunDeps, eligible: Candidate[]): Promise<{ orgItemId: string; orgName: string | null; wouldPropose: number }[]> {
  const counts = new Map<string, number>();
  for (const c of eligible) counts.set(c.orgItemId, (counts.get(c.orgItemId) ?? 0) + 1);
  const orgNames = await deps.monday.activeItems([...counts.keys()]);
  return [...counts.entries()]
    .map(([orgItemId, wouldPropose]) => ({ orgItemId, orgName: orgNames.get(orgItemId) ?? null, wouldPropose }))
    .sort((a, b) => b.wouldPropose - a.wouldPropose || a.orgItemId.localeCompare(b.orgItemId));
}
