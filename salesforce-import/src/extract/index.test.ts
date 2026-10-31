import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExtract } from './index.js';
import { readNdjson, readJson, dataPath } from '../artifacts.js';

const rowsByObject: Record<string, unknown[]> = {
  'FROM Contact': [{ Id: 'c1' }, { Id: 'c2' }],
  'FROM Opportunity': [{ Id: 'o1' }],
  'FROM funraise__Error__c': [{ expr0: 0 }],
};
const fakeExec = async (_cmd: string, args: string[]) => {
  const soql = args[args.indexOf('-q') + 1] ?? '';
  const key = Object.keys(rowsByObject).find((k) => soql.includes(k));
  const records = (key && rowsByObject[key] ? rowsByObject[key] : []).map((r) => ({ attributes: {}, ...(r as object) }));
  return { stdout: JSON.stringify({ status: 0, result: { records } }) };
};

describe('runExtract', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });

  it('writes extract NDJSON and a manifest with counts', async () => {
    expect(await runExtract([], { exec: fakeExec })).toBe(0);
    expect((await readNdjson(dataPath('extract', 'contacts.ndjson'))).length).toBe(2);
    const manifest = await readJson<{ counts: Record<string, number>; syncErrorCount: number }>(
      dataPath('extract', 'manifest.json'));
    expect(manifest.counts['contacts']).toBe(2);
    expect(manifest.syncErrorCount).toBe(0);
  });

  it('refuses to run while sync errors exist, unless acknowledged', async () => {
    rowsByObject['FROM funraise__Error__c'] = [{ expr0: 157 }];
    expect(await runExtract([], { exec: fakeExec })).toBe(1);
    expect(await runExtract(['--acknowledge-sync-errors'], { exec: fakeExec })).toBe(0);
    rowsByObject['FROM funraise__Error__c'] = [{ expr0: 0 }];
  });

  it('refuses a --consent with no path before running any query', async () => {
    const exec = vi.fn(fakeExec);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runExtract(['--consent'], { exec })).toBe(2);
      expect(await runExtract(['--consent', '--acknowledge-sync-errors'], { exec })).toBe(2);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});
