import { describe, it, expect, vi } from 'vitest';
import { BatchLookups } from './batchLookups';

describe('BatchLookups', () => {
  it('loads a key once and hands every caller the same result', async () => {
    const lookups = new BatchLookups();
    const load = vi.fn().mockResolvedValue('org-1');
    expect(await Promise.all([lookups.get('org:Acme', load), lookups.get('org:Acme', load)])).toEqual(['org-1', 'org-1']);
    expect(await lookups.get('org:Acme', load)).toBe('org-1');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps different keys apart', async () => {
    const lookups = new BatchLookups();
    expect(await lookups.get('a', async () => 1)).toBe(1);
    expect(await lookups.get('b', async () => 2)).toBe(2);
  });

  it('forgets a failed load, so the next caller tries again', async () => {
    const lookups = new BatchLookups();
    const load = vi.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce('ok');
    await expect(lookups.get('k', load)).rejects.toThrow('blip');
    expect(await lookups.get('k', load)).toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
