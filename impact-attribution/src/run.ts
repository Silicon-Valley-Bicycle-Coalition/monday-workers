import type { ImpactAttributionConfig } from './config';
import type { Environment } from './environment';
import { evidenceComment } from './evidence';
import type { ImpactMondayClient } from './monday/client';
import { qualifyingPairs, selectCandidates, type Candidate } from './rule';
import { allMatches, proposedPairs, recordProposal, refreshMatches } from './store';

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
  const { upserted, deleted } = await refreshMatches(db, read, deps.now);
  const qualifying = qualifyingPairs(await allMatches(db), config.rule, deps.today);
  const skips = {
    excludedOrgIds: new Set(config.excludedPayers.map((p) => p.id)),
    existingPairs: await monday.existingAffiliationPairs(config.affiliations),
    proposedPairs: await proposedPairs(db),
  };
  const { chosen, skipped, deferred } = selectCandidates(qualifying, skips, config.maxProposalsPerRun);

  // Post-import merges deleted some People and Organizations items; a candidate pointing at one is
  // skipped. The same read supplies the names for the Draft and the comment.
  const names = await monday.activeItems(chosen.flatMap((c) => [c.personItemId, c.orgItemId]));
  const live = chosen.filter((c) => names.has(c.personItemId) && names.has(c.orgItemId));
  const summary: RunSummary = {
    matchesRead: read.stored.length + read.rejectedIds.length, upserted, deleted, qualifying: qualifying.length,
    skipped: { ...skipped, missingItem: chosen.length - live.length }, proposed: 0, failed: 0, deferred,
  };
  for (const c of chosen) {
    if (!live.includes(c)) console.log(`${WORKER}: candidate ${c.personItemId}/${c.orgItemId} skipped: person or organization item is gone`);
  }

  if (mode === 'on') {
    for (const c of live) await propose(deps, c, names, summary);
    console.log(JSON.stringify({ worker: WORKER, environment: deps.environment, mode, ...summary }));
  } else {
    console.log(JSON.stringify({
      worker: WORKER, environment: deps.environment, mode, ...summary,
      wouldPropose: live.map((c) => ({ personItemId: c.personItemId, orgItemId: c.orgItemId, proposedStatus: c.proposedStatus, matches: c.matches.length })),
      payers: await payerSummary(deps, qualifying, skips),
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
async function payerSummary(
  deps: RunDeps,
  qualifying: Candidate[],
  skips: Parameters<typeof selectCandidates>[1],
): Promise<{ orgItemId: string; orgName: string | null; wouldPropose: number }[]> {
  const { chosen } = selectCandidates(qualifying, skips, Number.MAX_SAFE_INTEGER);
  const counts = new Map<string, number>();
  for (const c of chosen) counts.set(c.orgItemId, (counts.get(c.orgItemId) ?? 0) + 1);
  const orgNames = await deps.monday.activeItems([...counts.keys()]);
  return [...counts.entries()]
    .map(([orgItemId, wouldPropose]) => ({ orgItemId, orgName: orgNames.get(orgItemId) ?? null, wouldPropose }))
    .sort((a, b) => b.wouldPropose - a.wouldPropose || a.orgItemId.localeCompare(b.orgItemId));
}
