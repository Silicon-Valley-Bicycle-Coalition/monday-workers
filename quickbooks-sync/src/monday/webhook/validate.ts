export interface MondayItemCreatedEvent {
  mondayItemId: string;
  boardId: number;
  columnValues: Record<string, unknown>;
}

export function isChallengeRequest(body: unknown): body is { challenge: string } {
  return typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).challenge === 'string';
}

export function validateMondayEvent(body: unknown): MondayItemCreatedEvent {
  if (typeof body !== 'object' || body === null) {
    throw new Error('monday webhook: payload must be a JSON object');
  }
  const event = (body as Record<string, unknown>).event;
  if (typeof event !== 'object' || event === null) {
    throw new Error('monday webhook: missing "event" object');
  }

  const { pulseId, boardId, columnValues } = event as Record<string, unknown>;
  if (typeof pulseId !== 'number' && typeof pulseId !== 'string') {
    throw new Error('monday webhook: event missing "pulseId"');
  }
  if (typeof boardId !== 'number') {
    throw new Error('monday webhook: event missing "boardId"');
  }

  return {
    mondayItemId: String(pulseId),
    boardId,
    columnValues: (typeof columnValues === 'object' && columnValues !== null ? columnValues : {}) as Record<
      string,
      unknown
    >,
  };
}
