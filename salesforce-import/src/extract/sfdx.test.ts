import { describe, it, expect } from 'vitest';
import { runSoql } from './sfdx.js';

const fakeExec = (stdout: unknown) => async () => ({ stdout: JSON.stringify(stdout) });

describe('runSoql', () => {
  it('parses records and strips attributes', async () => {
    const exec = fakeExec({ status: 0, result: { records: [
      { attributes: { type: 'Contact' }, Id: '003xx', Email: 'a@b.c' },
    ] } });
    const rows = await runSoql('svbc', 'SELECT Id FROM Contact', { exec });
    expect(rows).toEqual([{ Id: '003xx', Email: 'a@b.c' }]);
  });

  it('throws on nonzero status with the CLI message', async () => {
    const exec = fakeExec({ status: 1, message: 'INVALID_TYPE' });
    await expect(runSoql('svbc', 'SELECT', { exec })).rejects.toThrow(/INVALID_TYPE/);
  });
});

describe('runSoqlPaginated', () => {
  const page = (rows: { Id: string }[]) => JSON.stringify({
    status: 0, result: { records: rows.map((r) => ({ attributes: {}, ...r })) },
  });

  it('keyset-paginates until a short page', async () => {
    const calls: string[] = [];
    const exec = async (_cmd: string, args: string[]) => {
      const soql = args[args.indexOf('-q') + 1] ?? '';
      calls.push(soql);
      if (!soql.includes('WHERE')) return { stdout: page([{ Id: 'A' }, { Id: 'B' }]) };
      if (soql.includes("Id > 'B'")) return { stdout: page([{ Id: 'C' }]) };
      throw new Error(`unexpected: ${soql}`);
    };
    const { runSoqlPaginated } = await import('./sfdx.js');
    const rows = await runSoqlPaginated('svbc', 'SELECT Id FROM Contact', { exec, pageSize: 2 });
    expect(rows.map((r) => r['Id'])).toEqual(['A', 'B', 'C']);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('ORDER BY Id LIMIT 2');
  });

  it('rejects base SOQL with WHERE/ORDER BY/LIMIT', async () => {
    const { runSoqlPaginated } = await import('./sfdx.js');
    await expect(runSoqlPaginated('svbc', 'SELECT Id FROM Contact WHERE X = 1', { pageSize: 2 }))
      .rejects.toThrow(/must not contain/);
  });
});
