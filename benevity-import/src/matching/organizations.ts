import type { MondayClient } from '../monday/client';
import type { AliasStore } from '../db/aliases';
import type { BenevityImportConfig } from '../types';

export type OrganizationResolution =
  | { status: 'resolved'; organizationItemId: string }
  | { status: 'unresolved'; reason: string };

function exactlyOne(items: { id: string; name: string }[], expectedName: string): string | null {
  const matches = items.filter((item) => item.name.toLowerCase() === expectedName.toLowerCase());
  return matches.length === 1 ? matches[0]!.id : null; // guarded by matches.length === 1 above
}

export async function resolveOrganization(
  mondayClient: MondayClient,
  aliasStore: AliasStore,
  config: BenevityImportConfig,
  companyName: string
): Promise<OrganizationResolution> {
  const boardId = config.monday.boards.organizations;
  if (boardId === null) {
    throw new Error('config: monday.boards.organizations is not configured');
  }

  const exact = await mondayClient.findItemsByName(boardId, companyName);
  const exactId = exactlyOne(exact, companyName);
  if (exactId) return { status: 'resolved', organizationItemId: exactId };
  if (exact.length > 1) {
    return { status: 'unresolved', reason: `"${companyName}" matches ${exact.length} Organizations by name` };
  }

  const learnedId = await aliasStore.getAlias(companyName);
  if (learnedId) return { status: 'resolved', organizationItemId: learnedId };

  const configAlias = config.benevityImport.organizationAliases[companyName];
  if (configAlias) {
    const aliased = await mondayClient.findItemsByName(boardId, configAlias);
    const aliasedId = exactlyOne(aliased, configAlias);
    if (aliasedId) return { status: 'resolved', organizationItemId: aliasedId };
  }

  return { status: 'unresolved', reason: `no Organization matches "${companyName}"` };
}
