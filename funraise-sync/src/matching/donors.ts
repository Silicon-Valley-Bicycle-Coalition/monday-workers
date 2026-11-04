import type { MondayClient } from '../monday/client';
import { MondayApiError } from '../monday/graphql';
import type { FunraiseSyncConfig } from '../types';
import { getPath } from '../util/getPath';

export interface DonorMatchResult {
  donorItemId: string;
  created: boolean;
}

// Funraise's supporter pages are global (no org slug). salesforce-import writes the People
// board's Funraise Profile link column as this URL with the bare id as the link text, and this
// Worker writes the same shape so a donor it creates looks like a migrated one.
const FUNRAISE_SUPPORTER_URL = 'https://platform.funraise.io/supporter/';

// Funraise sends `supporter.id` as a number; Monday column values and lookups want strings.
const externalIdString = (value: unknown): string | null => {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
};

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

  const externalId = externalIdString(getPath(rawPayload, donorExternalIdField));
  if (externalId !== null) {
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

  // Monday rejects bare strings on email and link columns — they need these small objects.
  // `items_page_by_column_values` still matches them by the bare address / link text, which is
  // what the two lookups above pass (verified live against the sandbox People board 2026-09-17).
  const created = await mondayClient.createItem(
    donorsBoardId,
    typeof donorName === 'string' && donorName.length > 0 ? donorName : 'Unknown Donor',
    {
      ...(primaryEmail ? { [donorEmailColumn]: { email: primaryEmail, text: primaryEmail } } : {}),
      ...(externalId !== null
        ? { [donorExternalIdColumn]: { url: `${FUNRAISE_SUPPORTER_URL}${externalId}`, text: externalId } }
        : {}),
    }
  );

  await writeNames(mondayClient, config, donorsBoardId, created.id, rawPayload);
  return { donorItemId: created.id, created: true };
}

// A separate, best-effort write after the create: Monday rejects a whole create_item over one bad
// column, and a name problem must never send a gift to retries and the dead-letter queue. A person
// whose names didn't write stays blank. The error's message could echo a value, so it isn't logged.
async function writeNames(
  mondayClient: MondayClient,
  config: FunraiseSyncConfig,
  boardId: number,
  itemId: string,
  rawPayload: Record<string, unknown>
): Promise<void> {
  const { donorFirstNameField, donorLastNameField, donorFirstNameColumn, donorLastNameColumn } = config.funraiseSync;
  const trimmed = (field: string): string => {
    const value = getPath(rawPayload, field);
    return typeof value === 'string' ? value.trim() : '';
  };
  const first = trimmed(donorFirstNameField);
  const last = trimmed(donorLastNameField);
  if (first === '' && last === '') return;
  try {
    await mondayClient.changeColumnValues(boardId, itemId, {
      ...(first !== '' ? { [donorFirstNameColumn]: first } : {}),
      ...(last !== '' ? { [donorLastNameColumn]: last } : {}),
    });
  } catch (err) {
    const detail = err instanceof MondayApiError ? `status ${err.httpStatus ?? '?'}, code ${err.code ?? '?'}` : 'not a Monday error';
    console.warn(`funraise-sync: no names written on People item ${itemId}: ${detail}`);
  }
}
