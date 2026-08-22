import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNdjson, readNdjson, appendNdjson, writeJson, readJson } from './artifacts.js';

describe('artifacts', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sfimp-')); });

  it('round-trips NDJSON and counts rows', async () => {
    const p = join(dir, 'x', 'contacts.ndjson'); // nested: helper must mkdir -p
    const n = await writeNdjson(p, [{ Id: 'a' }, { Id: 'b' }]);
    expect(n).toBe(2);
    expect(await readNdjson<{ Id: string }>(p)).toEqual([{ Id: 'a' }, { Id: 'b' }]);
  });

  it('appends single rows', async () => {
    const p = join(dir, 'ledger.ndjson');
    await appendNdjson(p, { sfId: '1' });
    await appendNdjson(p, { sfId: '2' });
    expect((await readNdjson(p)).length).toBe(2);
  });

  it('round-trips JSON', async () => {
    const p = join(dir, 'manifest.json');
    await writeJson(p, { counts: { Contact: 3 } });
    expect(await readJson<{ counts: { Contact: number } }>(p)).toEqual({ counts: { Contact: 3 } });
  });
});
