import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateCode } from './code';

function stubRandom(...values: number[]) {
  const queue = [...values];
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint32Array) => {
    array[0] = queue.shift()!;
    return array;
  }) as typeof crypto.getRandomValues);
}

describe('generateCode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns eight digits', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateCode()).toMatch(/^\d{8}$/);
    }
  });

  it('keeps leading zeros', () => {
    stubRandom(0x00000007);
    expect(generateCode()).toBe('00000007');
  });

  it('rejects values above the last full hundred million', () => {
    stubRandom(0xffffffff, 42);
    expect(generateCode()).toBe('00000042');
  });
});
