import { registerCommand } from '../commands.js';
import { loadConfig } from '../config.js';
import { dataPath, writeJson, writeNdjson } from '../artifacts.js';
import { CLI_ROW_CEILING, runSoql, runSoqlPaginated, type ExecFn } from './sfdx.js';
import { checkSyncErrorGate } from './gate.js';
import { buildExtracts } from './queries.js';

const CEILING_WARN_FRACTION = 0.8;

export async function runExtract(args: string[], deps: { exec?: ExecFn } = {}): Promise<number> {
  const cfg = loadConfig();
  const acknowledge = args.includes('--acknowledge-sync-errors');
  const gate = await checkSyncErrorGate(cfg.salesforceOrg, { exec: deps.exec, acknowledge });
  if (gate.blocked) {
    console.error(`extract: BLOCKED — ${gate.errorCount} live Funraise sync errors. ` +
      `Fix them (see docs 01 §5) or re-run with --acknowledge-sync-errors.`);
    return 1;
  }
  if (gate.errorCount > 0) console.warn(`extract: proceeding despite ${gate.errorCount} sync errors (acknowledged)`);

  const counts: Record<string, number> = {};
  for (const ex of buildExtracts(cfg)) {
    const soql = ex.soql.replace(/\s+/g, ' ').trim();
    const rows = ex.paginate
      ? await runSoqlPaginated(cfg.salesforceOrg, soql, { exec: deps.exec })
      : await runSoql(cfg.salesforceOrg, soql, { exec: deps.exec });
    if (!ex.paginate && rows.length >= CLI_ROW_CEILING) {
      // The CLI truncates silently at this ceiling — a full-looking page means data loss.
      throw new Error(`extract: ${ex.name} returned ${rows.length} rows (CLI truncation ceiling) — mark it paginate: true`);
    }
    if (!ex.paginate && rows.length >= CLI_ROW_CEILING * CEILING_WARN_FRACTION) {
      // Warn well before the hard stop above, so a growing object gets paginated before the
      // cutover-day extract is the one that trips it.
      console.warn(`extract: ${ex.name} returned ${rows.length} rows — within ` +
        `${Math.round((1 - CEILING_WARN_FRACTION) * 100)}% of the CLI ceiling; mark it paginate: true`);
    }
    const dir = ex.backupOnly ? 'backup' : 'extract';
    counts[ex.name] = await writeNdjson(dataPath(dir, `${ex.name}.ndjson`), rows);
    console.log(`extract: ${ex.name} → ${counts[ex.name]} rows (${dir})`);
  }
  const consentIdx = args.indexOf('--consent');
  if (consentIdx >= 0 && args[consentIdx + 1]) {
    const { ingestConsent } = await import('./consent.js');
    counts['consent'] = await ingestConsent(args[consentIdx + 1]!);
  }
  await writeJson(dataPath('extract', 'manifest.json'), {
    extractedAt: new Date().toISOString(), counts, syncErrorCount: gate.errorCount,
  });
  return 0;
}

registerCommand('extract', (args) => runExtract(args));
