import { describe, it, expect } from 'vitest';
import { sha256Hex } from './hash';

describe('sha256Hex', () => {
  it('matches the known SHA-256 test vector for the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'.slice(0, 64)
    );
  });

  it('matches the known SHA-256 test vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'.slice(0, 64)
    );
  });

  it('is deterministic for the same input', async () => {
    expect(await sha256Hex('same-input')).toBe(await sha256Hex('same-input'));
  });

  it('produces different hashes for different inputs', async () => {
    expect(await sha256Hex('input-a')).not.toBe(await sha256Hex('input-b'));
  });
});
