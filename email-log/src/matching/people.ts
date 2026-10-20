import type { MondayClient } from '../monday/client';
import type { EmailLogConfig } from '../types';

export interface MatchResult {
  personItemIds: string[];
  unmatched: string[];
}

// Addresses arrive lowercased, so no case fallback. Lookups are sequential on purpose:
// Monday's complexity budget is per-minute and a fan-out would spend it at once.
export async function matchAddresses(addresses: string[], client: MondayClient, config: EmailLogConfig): Promise<MatchResult> {
  const { boards } = config.monday;
  const { matching } = config;
  const seen = new Set<string>();
  const personItemIds: string[] = [];
  const unmatched: string[] = [];

  for (const address of addresses) {
    const found: string[] = [];

    if (boards['people-live'] !== null) {
      for (const column of matching.peopleEmailColumns) {
        found.push(...(await client.findItemIdsByColumnValue(boards['people-live'], column, address)));
      }
    }
    if (boards['people-historical'] !== null) {
      for (const column of matching.historicalEmailColumns) {
        found.push(...(await client.findItemIdsByColumnValue(boards['people-historical'], column, address)));
      }
    }
    if (boards.affiliations !== null && matching.affiliationsWorkEmailColumn !== null && matching.affiliationsPersonColumn !== null) {
      const affiliationIds = await client.findItemIdsByColumnValue(boards.affiliations, matching.affiliationsWorkEmailColumn, address);
      for (const affiliationId of affiliationIds) {
        found.push(...(await client.getConnectedItemIds(affiliationId, matching.affiliationsPersonColumn)));
      }
    }

    if (found.length === 0) {
      unmatched.push(address);
      continue;
    }
    for (const id of found) {
      if (!seen.has(id)) {
        seen.add(id);
        personItemIds.push(id);
      }
    }
  }
  return { personItemIds, unmatched };
}
