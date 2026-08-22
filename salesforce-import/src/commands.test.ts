import { describe, it, expect } from 'vitest';
import { registerCommand, runCli } from './commands.js';

describe('cli dispatch', () => {
  it('runs a registered command and returns its exit code', async () => {
    let got: string[] = [];
    registerCommand('noop', async (args) => { got = args; return 0; });
    expect(await runCli(['noop', '--dry-run'])).toBe(0);
    expect(got).toEqual(['--dry-run']);
  });

  it('returns 2 for unknown commands', async () => {
    expect(await runCli(['bogus'])).toBe(2);
  });
});
