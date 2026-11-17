import { answerCandidates, expireAndSupersede, mergeCandidates } from './answers/rule';
import { latestProposedAnswers, pendingAnswers, setAnswerStates, touchPending, type AnswerRow, type AnswerState } from './answers/store';
import type { ImpactAttributionConfig } from './config';
import { organizationNameVariants, pickOrganization } from './employerName';
import type { Environment } from './environment';
import { evidenceComment } from './evidence';
import type { ImpactMondayClient } from './monday/client';
import { qualifyingPairs, selectCandidates, type Candidate } from './rule';
import { allMatches, proposedPairs, recordProposal, refreshMatches, storedIdsNotIn, type ProposalSources } from './store';

// One nightly run (spec "Schedule and shape"). Logs carry item ids and counts only — never a
// person's name or email, and never an employer answer's text or context. Organization names
// appear only in the `off` payer summary.

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
  // Employer answers (design "Proposing it"). `pending` is what is still pending after the run;
  // `resolved`/`unresolved` count live answers that did / didn't name exactly one Organization.
  answers: { pending: number; expired: number; superseded: number; resolved: number; unresolved: number; skipped: number; proposed: number };
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
  const answers = await answerStep(deps);
  const candidates = mergeCandidates(qualifying, answers.candidates);
  const skips = {
    excludedOrgIds: new Set(config.excludedPayers.map((p) => p.id)),
    existingPairs: await monday.existingAffiliationPairs(config.affiliations),
    proposedPairs: await proposedPairs(db),
  };
  const { chosen: eligible, skipped, skippedCandidates } = selectCandidates(candidates, skips, Number.MAX_SAFE_INTEGER);
  const gone: Candidate[] = [];

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
    // A superseding employer's name is read too, for the Former Draft's comment.
    const ids = chunk.flatMap((c) => [c.personItemId, c.orgItemId, ...(c.supersededBy ? [c.supersededBy.orgItemId] : [])]);
    for (const [id, name] of await monday.activeItems([...new Set(ids)])) names.set(id, name);
    for (const c of chunk) {
      if (names.has(c.personItemId) && names.has(c.orgItemId)) {
        live.push(c);
      } else {
        missingItem++;
        gone.push(c);
        console.log(`${WORKER}: candidate ${c.personItemId}/${c.orgItemId} skipped: person or organization item is gone`);
      }
    }
  }
  // A skipped pair's answers are closed: the same skip would apply every night.
  const skippedAnswers = [...skippedCandidates.excluded, ...skippedCandidates.existing, ...skippedCandidates.proposed, ...gone]
    .flatMap((c) => c.answers.map((row) => ({ row, orgItemId: c.orgItemId })));
  await markAnswers(deps, skippedAnswers, 'skipped');
  const summary: RunSummary = {
    matchesRead: read.stored.length + read.rejectedIds.length, upserted, deleted, qualifying: qualifying.length,
    skipped: { ...skipped, missingItem }, proposed: 0, failed: 0, deferred: eligible.length - checked,
    answers: {
      pending: answers.resolved + answers.unresolved - skippedAnswers.length, expired: answers.expired, superseded: answers.superseded,
      resolved: answers.resolved, unresolved: answers.unresolved, skipped: skippedAnswers.length, proposed: 0,
    },
  };

  if (mode === 'on') {
    for (const c of live) await propose(deps, c, names, summary);
    console.log(JSON.stringify({ worker: WORKER, environment: deps.environment, mode, ...summary }));
  } else {
    console.log(JSON.stringify({
      worker: WORKER, environment: deps.environment, mode, ...summary,
      wouldPropose: live.map((c) => ({
        personItemId: c.personItemId, orgItemId: c.orgItemId, proposedStatus: c.proposedStatus, matches: c.matches.length, answers: c.answers.length,
      })),
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
      sources: sourcesOf(c),
    }, deps.now);
  } catch (err) {
    summary.failed++;
    console.error(`${WORKER}: proposal ${c.personItemId}/${c.orgItemId} failed: ${errorText(err)}`);
    return;
  }
  summary.proposed++;
  try {
    await markAnswers(deps, c.answers.map((row) => ({ row, orgItemId: c.orgItemId })), 'proposed');
    summary.answers.proposed += c.answers.length;
    summary.answers.pending -= c.answers.length;
  } catch (err) {
    // The ledger row already stops a second Draft; the next run marks these answers skipped.
    console.error(`${WORKER}: marking answers proposed for affiliation ${affiliationItemId} failed: ${errorText(err)}`);
  }
  try {
    const newer = c.supersededBy
      ? { orgName: names.get(c.supersededBy.orgItemId) ?? 'a newer employer', latestEvidence: c.supersededBy.latestEvidence, source: c.supersededBy.source }
      : undefined;
    await deps.monday.postUpdate(affiliationItemId, evidenceComment(orgName, c.matches, c.answers, newer));
  } catch (err) {
    // The Draft is the proposal; a missing comment doesn't undo it.
    console.error(`${WORKER}: evidence comment on affiliation ${affiliationItemId} failed: ${errorText(err)}`);
  }
}

const sourcesOf = (c: Candidate): ProposalSources =>
  c.answers.length === 0 ? 'matches' : c.matches.length === 0 ? 'answers' : 'both';

async function markAnswers(deps: RunDeps, answers: { row: AnswerRow; orgItemId: string }[], state: AnswerState): Promise<void> {
  await setAnswerStates(deps.db, answers.map(({ row, orgItemId }) => ({ source: row.source, sourceId: row.sourceId, state, orgItemId })), deps.now);
}

const NO_ANSWERS: ResolvedAnswers = { candidates: [], expired: 0, superseded: 0, resolved: 0, unresolved: 0 };

// A failing answer step (D1, the Organizations lookup) must not cost the night's match proposals:
// log the error class and message (never answer text) and carry on with no answer candidates.
async function answerStep(deps: RunDeps): Promise<ResolvedAnswers> {
  try {
    return await resolveAnswers(deps);
  } catch (err) {
    const name = err instanceof Error ? err.name : typeof err;
    console.error(`${WORKER}: answer step failed: ${name}: ${errorText(err)}`);
    return NO_ANSWERS;
  }
}

interface ResolvedAnswers { candidates: Candidate[]; expired: number; superseded: number; resolved: number; unresolved: number }

// Design "Proposing it" steps 1–4: expire and supersede pending answers (also against each
// person's latest proposed answer), then resolve each live one
// to an Organization by name. Every live answer is stamped `last_tried_at`; one that resolves to
// zero or several Organizations stays pending for the next night. The D1 changes happen under
// `off` too. Without `employerAnswers` config the step doesn't run.
async function resolveAnswers(deps: RunDeps): Promise<ResolvedAnswers> {
  const settings = deps.config.employerAnswers;
  if (settings === undefined) return NO_ANSWERS;
  const pending = await pendingAnswers(deps.db);
  const latestProposed = await latestProposedAnswers(deps.db, pending.map((r) => r.personItemId));
  const { live, expired, superseded } = expireAndSupersede(pending, deps.today, settings.maxAgeDays, latestProposed);
  await setAnswerStates(deps.db, [
    ...expired.map((r) => ({ source: r.source, sourceId: r.sourceId, state: 'expired' as const })),
    ...superseded.map((r) => ({ source: r.source, sourceId: r.sourceId, state: 'superseded' as const })),
  ], deps.now);
  await touchPending(deps.db, live.map((r) => ({ source: r.source, sourceId: r.sourceId })), deps.now);

  const names = [...new Set(live.flatMap((r) => organizationNameVariants(r.answer)))];
  const organizations = names.length === 0 ? [] : await deps.monday.findOrganizationsByNames(deps.config.organizationsBoardId, names);
  const resolved: { row: AnswerRow; orgItemId: string }[] = [];
  for (const row of live) {
    const pick = pickOrganization(row.answer, organizations);
    if (pick.kind === 'one') resolved.push({ row, orgItemId: pick.organization.id });
  }
  return {
    candidates: answerCandidates(resolved), expired: expired.length, superseded: superseded.length,
    resolved: resolved.length, unresolved: live.length - resolved.length,
  };
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
