// report-digests' side of the write switch (src/flags.ts, spec 2026-10-26). The Worker's only sink
// is the EMAIL binding: Monday is read, never written, and there is no D1, KV state or queue. So a
// dry run builds every digest exactly as a live run would — the Monday reads included — and only
// the send is swapped for a skip line.
import { recordingProxy, type SkipContext } from './flags';
import type { RunDeps } from './run';

// Everything a skip line needs except the delivery, which is per digest.
export type BatchSkipContext = Omit<SkipContext, 'deliveryId'>;

// The EMAIL binding with `send` recorded instead of made. The skip line's debug payload masks the
// recipients' addresses (the email pattern) and logs the html and text bodies by length only.
export function dryRunEmail(email: SendEmail, ctx: SkipContext): SendEmail {
  return recordingProxy(email, 'Email', { send: undefined }, ctx);
}

// The run deps for a cron run or operator request that runDisposition allowed: live for `run`,
// with the send recorded for `dry-run`.
export function runDepsFor(disposition: 'run' | 'dry-run', deps: RunDeps, ctx: SkipContext): RunDeps {
  if (disposition === 'run') return deps;
  return { ...deps, email: dryRunEmail(deps.email, ctx) };
}
