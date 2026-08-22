import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { dataPath, writeNdjson } from '../artifacts.js';

const STATUSES = ['unsubscribed', 'subscribed', 'cleaned'] as const;
type Status = (typeof STATUSES)[number];

function parseCsvLine(line: string): string[] {
  // Mailchimp quotes fields containing commas; minimal RFC4180 handling.
  const out: string[] = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export async function ingestConsent(csvPath: string): Promise<number> {
  const lines = (await readFile(csvPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0] ?? '').map((h) => h.trim().toLowerCase());
  const emailIdx = header.findIndex((h) => h === 'email address' || h === 'email');
  if (emailIdx < 0) throw new Error(`consent: no email column in ${csvPath}`);
  const statusIdx = header.indexOf('status');
  const fileStatus = STATUSES.find((s) => basename(csvPath).toLowerCase().includes(s));
  if (statusIdx < 0 && !fileStatus) throw new Error(`consent: no status column and none inferable from filename`);

  let skippedCount = 0;
  const rows = lines.slice(1)
    .map((line) => {
      const cells = parseCsvLine(line);
      const statusStr = statusIdx >= 0 ? cells[statusIdx]?.trim().toLowerCase() : fileStatus;
      if (!statusStr || !STATUSES.includes(statusStr as Status)) {
        skippedCount++;
        return null;
      }
      return { email: (cells[emailIdx] ?? '').trim().toLowerCase(), status: statusStr as Status };
    })
    .filter((r): r is { email: string; status: Status } => r !== null && Boolean(r.email));

  if (skippedCount > 0) console.warn(`consent: skipped ${skippedCount} rows with unrecognized status`);
  return writeNdjson(dataPath('extract', 'consent.ndjson'), rows);
}
