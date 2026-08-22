import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestConsent } from './consent.js';
import { readNdjson, dataPath } from '../artifacts.js';

describe('ingestConsent', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sfimp-')); process.chdir(dir); });

  it('parses a status-column export, lowercasing emails', async () => {
    const csv = 'Email Address,First Name,status\nDave@X.com,Dave,subscribed\nb@y.z,B,unsubscribed\n';
    const p = join(dir, 'audience.csv');
    writeFileSync(p, csv);
    expect(await ingestConsent(p)).toBe(2);
    expect(await readNdjson(dataPath('extract', 'consent.ndjson'))).toEqual([
      { email: 'dave@x.com', status: 'subscribed' },
      { email: 'b@y.z', status: 'unsubscribed' },
    ]);
  });

  it('infers status from filename when no status column (per-segment export)', async () => {
    const p = join(dir, 'unsubscribed_segment.csv');
    writeFileSync(p, 'Email Address\na@b.c\n');
    await ingestConsent(p);
    expect(await readNdjson(dataPath('extract', 'consent.ndjson'))).toEqual([
      { email: 'a@b.c', status: 'unsubscribed' },
    ]);
  });
});
