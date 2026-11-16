export function isChallenge(body: unknown): body is { challenge: string } {
  return typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).challenge === 'string';
}

export interface ValidatedUploadEvent {
  itemId: string;
  // Which column changed. Monday's webhook subscription is itself scoped to one column at setup
  // time, so this is normally redundant — but it's cheap to double-check at runtime rather than
  // trust that the subscription was configured correctly (spec: Trigger, "a file column on a
  // small staff-facing 'Benevity Uploads' board"), and the route (Task 16) uses it to ignore a
  // change on any other column instead of misreading its `value` shape as a file list.
  columnId: string;
  // The board the event fired on, checked by the route against the Uploads board (#106).
  boardId: string;
  assetIds: string[];
}

// The fields every column-change event carries: which item, which column.
function validateColumnChange(body: unknown): { e: Record<string, unknown>; itemId: string; columnId: string } {
  if (typeof body !== 'object' || body === null) {
    throw new Error('benevity webhook: payload must be a JSON object');
  }
  const event = (body as Record<string, unknown>).event;
  if (typeof event !== 'object' || event === null) {
    throw new Error('benevity webhook: payload missing "event"');
  }
  const e = event as Record<string, unknown>;
  const pulseId = e.pulseId;
  if (typeof pulseId !== 'number' && typeof pulseId !== 'string') {
    throw new Error('benevity webhook: event missing "pulseId"');
  }
  const columnId = e.columnId;
  if (typeof columnId !== 'string' || columnId === '') {
    throw new Error('benevity webhook: event missing "columnId"');
  }
  return { e, itemId: String(pulseId), columnId };
}

export function validateUploadEvent(body: unknown): ValidatedUploadEvent {
  const { e, itemId, columnId } = validateColumnChange(body);
  const boardId = e.boardId;
  if (typeof boardId !== 'number' && typeof boardId !== 'string') {
    throw new Error('benevity webhook: event missing "boardId"');
  }

  const value = e.value;
  const files =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>).files : undefined;
  const assetIds = Array.isArray(files)
    ? files
        .map((file) => (typeof file === 'object' && file !== null ? (file as Record<string, unknown>).assetId : undefined))
        .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
        .map(String)
    : [];
  if (assetIds.length === 0) {
    throw new Error('benevity webhook: event has no file assetIds');
  }

  return { itemId, columnId, boardId: String(boardId), assetIds };
}

export interface ValidatedRetryEvent {
  // The worklist item whose status changed.
  itemId: string;
  columnId: string;
  // The status label it changed to; '' when the column was cleared.
  label: string;
}

// A change on the worklist's Retry status column (`change_specific_column_value`). Monday sends a
// status value as `{ label: { index, text, ... }, post_id }`, or null when cleared.
export function validateRetryEvent(body: unknown): ValidatedRetryEvent {
  const { e, itemId, columnId } = validateColumnChange(body);
  const value = e.value;
  const label =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>).label : undefined;
  const text = typeof label === 'object' && label !== null ? (label as Record<string, unknown>).text : undefined;
  return { itemId, columnId, label: typeof text === 'string' ? text : '' };
}
