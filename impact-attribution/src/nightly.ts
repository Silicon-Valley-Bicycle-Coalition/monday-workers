import { runEmailDomainProposals } from './emailDomains/run';
import { runProposals, type RunDeps } from './run';

// One nightly run, two jobs, each a Draft Affiliation proposer writing to the shared `proposals`
// ledger. Matching gifts go first: they are the stronger evidence, so when both point a person at
// the same organization the Draft and its comment cite the gifts, and the email-domain job then
// sees the pair in the ledger. A job that throws is logged and the other still runs; the run then
// rethrows so the cron shows as failed.
const JOBS: { name: string; run: (deps: RunDeps, mode: 'on' | 'off') => Promise<unknown> }[] = [
  { name: 'matching-gift proposals', run: runProposals },
  { name: 'email-domain proposals', run: runEmailDomainProposals },
];

export async function runNightly(deps: RunDeps, mode: 'on' | 'off'): Promise<void> {
  const failed: string[] = [];
  for (const job of JOBS) {
    try {
      await job.run(deps, mode);
    } catch (err) {
      failed.push(job.name);
      console.error(JSON.stringify({
        worker: 'impact-attribution', environment: deps.environment, event: 'jobFailed', job: job.name,
        error: err instanceof Error ? err.name : 'unknown',
      }));
    }
  }
  if (failed.length > 0) throw new Error(`${failed.join(', ')} failed`);
}
