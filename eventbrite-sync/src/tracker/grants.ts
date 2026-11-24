import type { TrackerEvent } from './types';

export interface GrantPlanInput {
  // One per qualifying row.
  votes: { eventItemId: string; funder: string }[];
  events: Map<string, TrackerEvent>;
  // What the Worker last wrote or adopted (D1 event_grants), by Events item id.
  records: Map<string, string>;
  // Events a row may point at that couldn't be judged this run.
  untouchable: Set<string>;
  grantByFunder: Record<string, string>;
}

export interface GrantPlan {
  // To Monday; null clears.
  writes: { eventItemId: string; grant: string | null }[];
  // D1 only: a Grant found already right, or one a person has since changed.
  remember: { eventItemId: string; grant: string }[];
  forget: string[];
  conflicts: string[];
}

/**
 * Which Events items get which Grant. A blank Funder doesn't vote; the rest must agree. A Grant no
 * longer backed by a row is cleared only if it is still the Worker's own, so a fixed mis-link doesn't
 * leave a class in a funder's report, and a Grant on an event no row ever linked is never touched.
 */
export function planGrants({ votes, events, records, untouchable, grantByFunder }: GrantPlanInput): GrantPlan {
  const plan: GrantPlan = { writes: [], remember: [], forget: [], conflicts: [] };

  // Every event with a row or a record, with the distinct grants its rows vote for (null: no grant).
  const ballots = new Map<string, Set<string | null>>([...records.keys()].map((id) => [id, new Set()]));
  for (const { eventItemId, funder } of votes) {
    const ballot = ballots.get(eventItemId) ?? new Set();
    ballots.set(eventItemId, ballot);
    if (funder !== '') ballot.add(grantByFunder[funder] ?? null);
  }

  for (const [eventItemId, ballot] of ballots) {
    const event = events.get(eventItemId);
    if (event === undefined || !event.active || untouchable.has(eventItemId)) continue;
    if (ballot.size > 1) {
      plan.conflicts.push(eventItemId);
      continue;
    }
    const [grant = null] = ballot;
    const record = records.get(eventItemId) ?? null;
    if (grant !== null) {
      if (event.grant !== grant) plan.writes.push({ eventItemId, grant });
      else if (record !== grant) plan.remember.push({ eventItemId, grant });
    } else if (record !== null) {
      if (event.grant === record) plan.writes.push({ eventItemId, grant: null });
      else plan.forget.push(eventItemId);
    }
  }
  return plan;
}
