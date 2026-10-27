import { runDisposition } from '../flags';
import { reconcileDepsFor, type BatchSkipContext } from '../writeSwitch';
import type { ReconcileDeps, ReconcileResult } from './reconcile';

// The daily reconcile cron under the write switch: `on` reconciles for real, `off` rehearses it
// against recording proxies, `hold` / an unreadable switch skip the run (nothing to move: the
// cron keeps no cursor, and tomorrow's run reconciles whatever is still different).
export async function runScheduledReconcile(
  gate: BatchSkipContext,
  deps: ReconcileDeps,
  reconcile: (deps: ReconcileDeps) => Promise<ReconcileResult>,
): Promise<void> {
  const disposition = runDisposition(gate.mode);
  if (disposition === 'skip') {
    console.warn(`mailchimp-sync reconcile: write mode is "${gate.mode}"; skipping the campaign reconcile`);
    return;
  }
  const ctx = { ...gate, deliveryId: 'reconcile-cron' };
  const result = await reconcile(reconcileDepsFor(disposition, deps, ctx));
  console.log(`mailchimp-sync reconcile${disposition === 'dry-run' ? ' (dry run)' : ''}: created ${result.created}, renamed ${result.renamed}, archived ${result.archived}`);
}
