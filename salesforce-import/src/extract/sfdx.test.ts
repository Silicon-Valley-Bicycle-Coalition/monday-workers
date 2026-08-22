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
