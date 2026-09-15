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
  assetIds: string[];
}

export function validateUploadEvent(body: unknown): ValidatedUploadEvent {
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

  return { itemId: String(pulseId), columnId, assetIds };
}
