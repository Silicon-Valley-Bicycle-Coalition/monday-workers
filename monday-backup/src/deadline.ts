// A wall-clock deadline shared by the backup and its API clients (issue #29).
//
// Checking a budget only between pages isn't enough: one Monday or Drive call retrying through
// timeouts and advised waits could otherwise run for minutes past it. Clients cap every attempt's
// timeout and every retry sleep to the time remaining, and throw BudgetExhaustedError instead of
// crossing the deadline.
//
// It is mutable on purpose: runSnapshot gives each Workflow step its own window, so a call stuck in
// one board fails with a clear message and the next board starts fresh.

export const BUDGET_EXHAUSTED = 'wall-time budget exhausted';

export class BudgetExhaustedError extends Error {
  constructor(detail: string) {
    super(`${BUDGET_EXHAUSTED} — ${detail}`);
    this.name = 'BudgetExhaustedError';
  }
}

export class Deadline {
  constructor(
    // Epoch ms. Infinity (the default) means unbounded — e.g. the local restore CLI.
    public atMs: number = Number.POSITIVE_INFINITY,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  remainingMs(): number {
    return this.atMs - this.clock();
  }

  // Throws if the deadline has passed; `what` names the call for the error message.
  check(what: string): void {
    if (this.remainingMs() <= 0) throw new BudgetExhaustedError(`gave up on ${what}`);
  }

  // A per-attempt timeout that never runs past the deadline.
  timeoutMs(maxMs: number): number {
    return Math.max(1, Math.min(maxMs, this.remainingMs()));
  }

  // Sleeps `ms` before a retry, unless that retry would start past the deadline — then throws.
  async sleepBeforeRetry(sleep: (ms: number) => Promise<void>, ms: number, what: string): Promise<void> {
    if (ms >= this.remainingMs()) throw new BudgetExhaustedError(`not retrying ${what}`);
    await sleep(ms);
  }
}
