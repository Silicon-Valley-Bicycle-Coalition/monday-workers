// One Monday write budget per cron run (issue GL#90). The duties' own caps (classify 300, recurring
// 500, rollcall's writesPerRun, archive 40) all ran inside one scheduled() call, so a night when
// several backfills coincided could queue ~1,050 sequential mutations against the 15-minute cron
// limit; a wall-time kill records no custodian_runs row and starves rollcall, which runs last.
//
// Each duty asks take() before every Monday write and stops when refused, reporting the rest as
// remaining. Every duty that draws on it is diff-based (classify, recurring, rollcall) or works
// from a shrinking list (archive), so nothing unwritten is skipped: the next run finds it again,
// and dutiesForDate re-runs a duty whose last report has remaining > 0.
export const DEFAULT_WRITES_PER_RUN = 500;

export class WriteBudget {
  remaining: number;

  constructor(writes: number) {
    this.remaining = writes;
  }

  // An HTTP-triggered duty run: only the duty's own cap applies.
  static unlimited(): WriteBudget {
    return new WriteBudget(Number.POSITIVE_INFINITY);
  }

  take(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining -= 1;
    return true;
  }
}
