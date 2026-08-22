import { runSoql, type ExecFn } from './sfdx.js';

export async function checkSyncErrorGate(
  org: string,
  opts: { exec?: ExecFn; acknowledge?: boolean } = {},
): Promise<{ errorCount: number; blocked: boolean }> {
  const rows = await runSoql(org, 'SELECT COUNT(Id) FROM funraise__Error__c', { exec: opts.exec });
  const errorCount = Number(rows[0]?.['expr0'] ?? 0);
  return { errorCount, blocked: errorCount > 0 && !opts.acknowledge };
}
