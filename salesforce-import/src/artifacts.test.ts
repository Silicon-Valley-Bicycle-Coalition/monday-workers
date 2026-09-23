import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNdjson, readNdjson, appendNdjson, writeJson, readJson, repairTornTail } from './artifacts.js';

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

  it('repairTornTail drops a partial final row so the next append starts on a clean line', async () => {
    const p = join(dir, 'ledger.ndjson');
    writeFileSync(p, '{"sfId":"1"}\n{"sfId":"2"}\n{"sfId":"3","it');
    expect(await repairTornTail(p)).toBe('{"sfId":"3","it');
    await appendNdjson(p, { sfId: '4' });
    expect(await readNdjson(p)).toEqual([{ sfId: '1' }, { sfId: '2' }, { sfId: '4' }]);
  });

  it('repairTornTail keeps a complete final row that only lacks its newline, and leaves clean files alone', async () => {
    const p = join(dir, 'ledger.ndjson');
    writeFileSync(p, '{"sfId":"1"}\n{"sfId":"2"}');
    expect(await repairTornTail(p)).toBeNull();
    expect(readFileSync(p, 'utf8')).toBe('{"sfId":"1"}\n{"sfId":"2"}\n');
    expect(await repairTornTail(p)).toBeNull();
    expect(readFileSync(p, 'utf8')).toBe('{"sfId":"1"}\n{"sfId":"2"}\n');
  });

  it('readNdjson still throws on corruption that is not a torn tail', async () => {
    const p = join(dir, 'ledger.ndjson');
    writeFileSync(p, '{"sfId":"1"}\n{bad\n{"sfId":"2"}\n');
    expect(await repairTornTail(p)).toBeNull();
    await expect(readNdjson(p)).rejects.toThrow();
  });

  it('round-trips JSON', async () => {
    const p = join(dir, 'manifest.json');
    await writeJson(p, { counts: { Contact: 3 } });
    expect(await readJson<{ counts: { Contact: number } }>(p)).toEqual({ counts: { Contact: 3 } });
  });
});
