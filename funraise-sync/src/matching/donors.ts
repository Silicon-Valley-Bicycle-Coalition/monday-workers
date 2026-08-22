import type { MondayClient } from '../monday/client';
import type { FunraiseSyncConfig } from '../types';

export interface DonorMatchResult {
  donorItemId: string;
  created: boolean;
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (typeof acc !== 'object' || acc === null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

export async function matchDonor(
  mondayClient: MondayClient,
  config: FunraiseSyncConfig,
  rawPayload: Record<string, unknown>
): Promise<DonorMatchResult> {
  const donorsBoardId = config.monday.boards['people-live'];
  if (donorsBoardId === null) {
    throw new Error('config: monday.boards.people-live is not configured');
  }

  const { donorExternalIdField, donorExternalIdColumn, donorEmailColumn, donorNameField, emailFieldPrecedence } =
    config.funraiseSync;

  const externalId = getPath(rawPayload, donorExternalIdField);
  if (typeof externalId === 'string' && externalId.length > 0) {
    const existing = await mondayClient.findItemByColumnValue(donorsBoardId, donorExternalIdColumn, externalId);
    if (existing) return { donorItemId: existing.id, created: false };
  }

  for (const emailField of emailFieldPrecedence) {
    const email = getPath(rawPayload, emailField);
    if (typeof email === 'string' && email.length > 0) {
      const existing = await mondayClient.findItemByColumnValue(donorsBoardId, donorEmailColumn, email);
      if (existing) return { donorItemId: existing.id, created: false };
    }
  }

  const primaryEmail = emailFieldPrecedence
    .map((field) => getPath(rawPayload, field))
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  const donorName = getPath(rawPayload, donorNameField);

  const created = await mondayClient.createItem(
    donorsBoardId,
    typeof donorName === 'string' && donorName.length > 0 ? donorName : 'Unknown Donor',
    {
      ...(primaryEmail ? { [donorEmailColumn]: primaryEmail } : {}),
      ...(typeof externalId === 'string' && externalId.length > 0 ? { [donorExternalIdColumn]: externalId } : {}),
    }
  );

  return { donorItemId: created.id, created: true };
}
