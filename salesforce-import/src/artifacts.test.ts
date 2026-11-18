import { describe, it, expect, beforeEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNdjson, readNdjson, appendNdjson, writeJson, readJson, repairTornTail,
  writeText } from './artifacts.js';

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

// data/ holds full donor PII: owner-only regardless of umask (GL#111).
describe('artifacts file permissions', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sfimp-')); });
  const mode = (p: string) => statSync(p).mode & 0o777;

  it('creates directories 0700 and files 0600', async () => {
    const nd = join(dir, 'a', 'b', 'x.ndjson');
    await writeNdjson(nd, [{ Id: 'a' }]);
    expect(mode(join(dir, 'a'))).toBe(0o700);
    expect(mode(join(dir, 'a', 'b'))).toBe(0o700);
    expect(mode(nd)).toBe(0o600);

    const led = join(dir, 'c', 'ledger.ndjson');
    await appendNdjson(led, { sfId: '1' });
    expect(mode(join(dir, 'c'))).toBe(0o700);
    expect(mode(led)).toBe(0o600);

    const js = join(dir, 'd', 'r.json');
    await writeJson(js, { ok: true });
    expect(mode(js)).toBe(0o600);

    const txt = join(dir, 'e', 'r.csv');
    await writeText(txt, 'a,b\n');
    expect(readFileSync(txt, 'utf8')).toBe('a,b\n');
    expect(mode(txt)).toBe(0o600);
  });

  it('tightens a pre-existing world-readable file and its directory on rewrite', async () => {
    const sub = join(dir, 'old');
    mkdirSync(sub);
    chmodSync(sub, 0o755);
    const p = join(sub, 'x.json');
    writeFileSync(p, '{}');
    chmodSync(p, 0o644);
    await writeJson(p, { ok: true });
    expect(mode(p)).toBe(0o600);
    expect(mode(sub)).toBe(0o700);
  });
});
