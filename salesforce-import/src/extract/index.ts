import { registerCommand } from '../commands.js';
import { loadConfig } from '../config.js';
import { dataPath, writeJson, writeNdjson } from '../artifacts.js';
import { runSoql, type ExecFn } from './sfdx.js';
import { checkSyncErrorGate } from './gate.js';
import { buildExtracts } from './queries.js';

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
    const rows = await runSoql(cfg.salesforceOrg, ex.soql.replace(/\s+/g, ' ').trim(), { exec: deps.exec });
    const dir = ex.backupOnly ? 'backup' : 'extract';
    counts[ex.name] = await writeNdjson(dataPath(dir, `${ex.name}.ndjson`), rows);
    console.log(`extract: ${ex.name} → ${counts[ex.name]} rows (${dir})`);
  }
  await writeJson(dataPath('extract', 'manifest.json'), {
    extractedAt: new Date().toISOString(), counts, syncErrorCount: gate.errorCount,
  });
  return 0;
}

registerCommand('extract', (args) => runExtract(args));
