// A failure that no retry can fix — QuickBooks rejected the data itself (a duplicate name, a
// missing required field), or the thing to sync no longer exists. The consumer records it on the
// row and acks the message instead of burning retries into the DLQ. Fix the cause (usually the
// Monday item or the QuickBooks record), then redrive the row (README "Dead letters and redrive").
export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

export function isTerminalError(err: unknown): err is TerminalError {
  return err instanceof TerminalError;
}
