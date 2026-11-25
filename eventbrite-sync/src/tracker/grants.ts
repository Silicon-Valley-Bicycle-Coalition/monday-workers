import type { TrackerEvent } from './types';

// What the Worker last wrote or adopted as an event's Grant (D1 event_grants), and the row behind it.
export interface GrantRecord {
  grant: string;
  trackerItemId: string;
}

export type GrantWrite = GrantRecord & { eventItemId: string };

export interface GrantPlanInput {
  // One per qualifying row.
  votes: { eventItemId: string; trackerItemId: string; funder: string }[];
  events: Map<string, TrackerEvent>;
  records: Map<string, GrantRecord>;
  // Every tracker row on the board.
  rowsRead: Set<string>;
  // Events a row may point at that couldn't be judged this run.
  untouchable: Set<string>;
  grantByFunder: Record<string, string>;
}

export interface GrantPlan {
  writes: GrantWrite[];
  clears: string[];
  // D1 only: a Grant found already right, or one a person has since changed.
  remember: GrantWrite[];
  forget: string[];
  conflicts: string[];
}

/**
 * Which Events items get which Grant. A blank Funder doesn't vote; the rest must agree. A Grant no
 * longer backed by a row is cleared only if it is still the Worker's own, and only when the row behind
 * it is still on the board, so fixing a mis-link takes a class out of a funder's report but archiving
 * finished rows doesn't. A Grant on an event no row ever linked is never touched.
 */
export function planGrants({ votes, events, records, rowsRead, untouchable, grantByFunder }: GrantPlanInput): GrantPlan {
  const plan: GrantPlan = { writes: [], clears: [], remember: [], forget: [], conflicts: [] };

  // Every event with a row or a record: each grant its rows vote for (null: no grant), with the voters.
  const ballots = new Map<string, Map<string | null, string[]>>([...records.keys()].map((id) => [id, new Map()]));
  for (const { eventItemId, trackerItemId, funder } of votes) {
    const ballot = ballots.get(eventItemId) ?? new Map<string | null, string[]>();
    ballots.set(eventItemId, ballot);
    if (funder === '') continue;
    const grant = grantByFunder[funder] ?? null;
    ballot.set(grant, [...(ballot.get(grant) ?? []), trackerItemId]);
  }

  for (const [eventItemId, ballot] of ballots) {
    const event = events.get(eventItemId);
    if (event === undefined || !event.active || untouchable.has(eventItemId)) continue;
    if (ballot.size > 1) {
      plan.conflicts.push(eventItemId);
      continue;
    }
    const [[grant, voters] = [null, []]] = ballot;
    const record = records.get(eventItemId);
    if (grant !== null) {
      const backed = { eventItemId, grant, trackerItemId: voters[0]! };
      if (event.grant !== grant) plan.writes.push(backed);
      else if (record?.grant !== grant || !voters.includes(record.trackerItemId)) plan.remember.push(backed);
    } else if (record !== undefined) {
      if (event.grant !== record.grant) plan.forget.push(eventItemId);
      else if (ballot.has(null) || rowsRead.has(record.trackerItemId)) plan.clears.push(eventItemId);
    }
  }
  return plan;
}
