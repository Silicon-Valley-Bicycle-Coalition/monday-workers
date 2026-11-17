import type { RunDeps } from '../run';
import { proposedPairs, recordProposal } from '../store';
import { buildDomainMap } from './domains';
import { emailIndexRows, rebuildEmailIndex } from './emailIndex';
import { selectProposals, type PersonRecord, type SkipReason } from './select';

// The nightly run's second job (#124): propose an employer from a donor's company email domain.
// Same shape as the matching-gift job (src/run.ts): a Draft Affiliation with Proposed status
// Current, the evidence as a comment, and a row in the shared `proposals` ledger, so a pair either
// job proposed is never proposed again by the other. `off` computes and logs what it would
// propose and writes nothing to Monday or the ledger; the email index is rebuilt either way,
// since it is this Worker's own state. Logs carry ids, counts and domains, never a name or an
// address.

const WORKER = 'impact-attribution';

export interface EmailDomainSummary {
  mode: 'on' | 'off';
  people: number;
  proposed: number;
  wouldPropose: number;
  failed: number;
  deferred: number;
  skipped: Record<SkipReason, number>;
  ambiguousDomains: number;
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown');

export async function runEmailDomainProposals(deps: RunDeps, mode: 'on' | 'off'): Promise<EmailDomainSummary> {
  const { monday, db, config } = deps;
  const ed = config.emailDomains;

  const people: PersonRecord[] = [];
  for (const boardId of config.peopleBoardIds) people.push(...await monday.listPeople(boardId, ed.people));
  const [organizations, affiliations] = await Promise.all([
    monday.listOrganizations(config.organizationsBoardId, ed.organizationWebsite),
    monday.listAffiliations(config.affiliations, ed.affiliationWorkEmail),
  ]);
  // An empty read is a failed read, not "nothing to do": abort before touching the index.
  if (people.length === 0) throw new Error('read returned no People; aborting');
  if (organizations.length === 0) throw new Error('read returned no Organizations; aborting');

  await rebuildEmailIndex(db, emailIndexRows(people, affiliations));

  // An override pointing at a deleted or merged organization would fail its create every night;
  // drop it and name it in the domains log line instead.
  const orgIds = new Set(organizations.map((o) => o.itemId));
  const overrides = Object.fromEntries(Object.entries(ed.domainOverrides).filter(([, id]) => orgIds.has(id)));
  const staleOverrides = Object.entries(ed.domainOverrides).filter(([, id]) => !orgIds.has(id))
    .map(([domain, organizationId]) => ({ domain, organizationId }));
  const domainMap = buildDomainMap(organizations, affiliations, {
    currentLabel: config.affiliations.labels.current, overrides, platformDomains: new Set(ed.platformDomains),
  });
  const selection = selectProposals({
    people, affiliations, organizations, domainMap,
    blocked: new Set([...ed.consumerDomains, ...ed.excludedDomains]),
    proposedPairs: await proposedPairs(db),
    labels: config.affiliations.labels,
    cap: ed.maxProposalsPerRun,
  });

  let proposed = 0;
  let failed = 0;
  if (mode === 'on') {
    for (const p of selection.proposals) {
      let affiliationItemId: string;
      try {
        affiliationItemId = await monday.createDraft(config.affiliations, {
          name: `${p.person.name} @ ${p.organizationName}`, personItemId: p.person.itemId, orgItemId: p.organizationId, proposedStatus: 'Current',
        });
      } catch (err) {
        // Not recorded, so the next run proposes it again.
        failed++;
        console.error(JSON.stringify({ worker: WORKER, event: 'emailDomainCreateFailed', personItemId: p.person.itemId, error: errorName(err) }));
        continue;
      }
      proposed++;
      try {
        await recordProposal(db, {
          personItemId: p.person.itemId, orgItemId: p.organizationId, affiliationItemId, proposedStatus: 'Current', matchCount: 0,
          evidence: 'email_domain', domain: p.domain,
        }, deps.now);
      } catch (err) {
        // The Draft exists, so tomorrow's run skips this person (hasCurrentOrDraft); only the
        // memory of a later rejection is lost.
        console.error(JSON.stringify({ worker: WORKER, event: 'emailDomainLedgerWriteFailed', affiliationItemId, error: errorName(err) }));
      }
      try {
        await monday.postUpdate(affiliationItemId, p.proposedFrom);
      } catch (err) {
        // The Draft is the proposal; a missing comment doesn't undo it.
        console.error(JSON.stringify({ worker: WORKER, event: 'emailDomainCommentFailed', affiliationItemId, error: errorName(err) }));
      }
    }
  }

  const summary: EmailDomainSummary = {
    mode, people: people.length, proposed, wouldPropose: mode === 'off' ? selection.proposals.length : 0,
    failed, deferred: selection.deferred, skipped: selection.skipped, ambiguousDomains: domainMap.ambiguous.size,
  };
  console.log(JSON.stringify({ worker: WORKER, environment: deps.environment, operation: 'emailDomainProposals', ...summary }));
  // What the operator needs to tune domainOverrides / excludedDomains / platformDomains: each
  // domain this run proposed from (or would have, under off) and each ambiguous one.
  const byDomain = new Map<string, { domain: string; organizationId: string; source: string; proposals: number }>();
  for (const p of selection.proposals) {
    const entry = byDomain.get(p.domain) ?? { domain: p.domain, organizationId: p.organizationId, source: domainMap.mapped.get(p.domain)?.source ?? '', proposals: 0 };
    entry.proposals++;
    byDomain.set(p.domain, entry);
  }
  console.log(JSON.stringify({
    worker: WORKER, environment: deps.environment, operation: 'emailDomainProposalDomains', mode,
    proposedDomains: [...byDomain.values()].sort((a, b) => b.proposals - a.proposals || a.domain.localeCompare(b.domain)),
    ambiguousDomains: [...domainMap.ambiguous].sort(),
    staleOverrides,
  }));
  return summary;
}
