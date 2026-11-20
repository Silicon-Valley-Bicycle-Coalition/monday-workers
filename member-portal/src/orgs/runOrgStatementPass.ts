import type { MondayClient, OrgAffiliation } from '../monday/client';
import { orgStatementKey, type OrgStatementSendStore } from '../db/orgStatementSends';
import type { Config, LetterSendQueueMessage } from '../types';
import type { WriteMode } from '../flags';
import { stampedQueue } from '../writeSwitch';
import { errorText } from '../logSafe';

export interface OrgStatementPassDeps {
  monday: MondayClient;
  store: OrgStatementSendStore;
  queue: { send(message: LetterSendQueueMessage): Promise<void> };
  config: Config;
  now: () => Date;
  // The write switch's mode for this run; every message is stamped with it.
  mode: WriteMode;
}

export interface OrgStatementPassResult {
  eligibleReps: number; // reps of the swept organizations (Current + Portal access, with an address to try)
  alreadyHandled: number; // dropped by the org_statement_sends pre-check
  triggered: number; // sends queued this run
  failed: number; // an Affiliations read or a trigger threw — retried on the next daily run
  deferred: number; // beyond the budget — picked up by the next daily run
}

// A rep the January email goes to: a Current Affiliation with Portal access, still linked to this
// organization, with someone to write to (a person, whose Personal Email the consumer reads, or a
// Work Email). The consumer re-checks all of it at send time.
function isRep(aff: OrgAffiliation, orgItemId: string, currentStatusLabel: string): boolean {
  return (
    aff.statusLabel === currentStatusLabel &&
    aff.portalAccess &&
    aff.organizationId === orgItemId &&
    (aff.personItemId !== null || aff.workEmail.trim() !== '')
  );
}

// The letter cron's organization pass (spec "January email"): one statement email per rep of each
// organization with activity in `year`, deduped per (organization, Affiliation, year), so a rerun
// queues nothing twice and a rep added later gets theirs on the next run. `budget` is what the
// person pass left of maxTriggersPerRun. Every swept organization's Affiliations are read each run
// (a rep can be added at any time, so there is no Monday-free pre-check as for people), but only
// `budget` sends are queued. The caller checks the gates (write switch, settings, orgAccessEnabled).
export async function runOrgStatementPass(
  deps: OrgStatementPassDeps,
  year: number,
  organizationIds: string[],
  budget: number
): Promise<OrgStatementPassResult> {
  const current = deps.config.changeRequests.employer!.currentStatusLabel;
  const queue = stampedQueue(deps.queue, deps.mode);
  const handled = await deps.store.listKeysForYear(year);

  let eligibleReps = 0;
  let failed = 0;
  const pending: { orgItemId: string; affiliationItemId: string }[] = [];
  // Sequential, like the person pass: the Monday complexity budget is shared.
  for (const orgItemId of organizationIds) {
    let affiliations: OrgAffiliation[];
    try {
      affiliations = await deps.monday.getOrganizationAffiliations(orgItemId);
    } catch (err) {
      failed++;
      console.error(`member-portal letter cron: Affiliations read failed for organization ${orgItemId} (retried tomorrow): ${errorText(err)}`);
      continue;
    }
    for (const aff of affiliations) {
      if (!isRep(aff, orgItemId, current)) continue;
      eligibleReps++;
      if (!handled.has(orgStatementKey(orgItemId, aff.id))) pending.push({ orgItemId, affiliationItemId: aff.id });
    }
  }

  const batch = pending.slice(0, Math.max(0, budget));
  let triggered = 0;
  for (const rep of batch) {
    try {
      if (await trigger(rep.orgItemId, rep.affiliationItemId, year, deps, queue)) triggered++;
    } catch (err) {
      failed++;
      console.error(
        `member-portal letter cron: statement trigger failed for affiliation ${rep.affiliationItemId} (retried tomorrow): ${errorText(err)}`
      );
    }
  }

  return { eligibleReps, alreadyHandled: eligibleReps - pending.length, triggered, failed, deferred: pending.length - batch.length };
}

// triggerLetterSend's dedupe-hit handling, for a row written after the pre-check: a stranded
// 'queued' row is re-sent (the consumer is idempotent on status), a 'skipped' one is requeued for
// a fresh attempt, and 'sending'/'sent' are left alone. True when a new send is in flight.
async function trigger(
  orgItemId: string,
  affiliationItemId: string,
  year: number,
  deps: OrgStatementPassDeps,
  queue: { send(message: LetterSendQueueMessage): Promise<void> }
): Promise<boolean> {
  const nowISO = deps.now().toISOString();
  const existing = await deps.store.findByKey(orgItemId, affiliationItemId, year);
  if (existing !== null) {
    if (existing.status === 'queued') {
      await queue.send({ sendId: existing.id, kind: 'org' });
      return false;
    }
    if (existing.status === 'skipped') {
      await deps.store.requeue(existing.id, nowISO);
      await queue.send({ sendId: existing.id, kind: 'org' });
      return true;
    }
    return false;
  }
  const id = await deps.store.createQueued({ orgItemId, affiliationItemId, year, createdAt: nowISO });
  await queue.send({ sendId: id, kind: 'org' });
  return true;
}
