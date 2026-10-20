import { describe, it, expect } from 'vitest';
import { messageIdHash } from './dedupe';

const fallback = { from: 'Alice@Example.com', dateISO: '2026-10-20T10:00:00.000Z', subject: 'Hello' };

describe('messageIdHash', () => {
  it('normalizes Message-ID', async () => {
    const a = await messageIdHash({ messageId: '  <Abc.DEF@Example.COM> ' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await messageIdHash({ messageId: 'Abc.DEF@example.com' })).toBe(a);
    // Only the domain is case-insensitive.
    expect(await messageIdHash({ messageId: 'abc.def@example.com' })).not.toBe(a);
  });

  it('same Message-ID → same hash', async () => {
    expect(await messageIdHash({ messageId: '<x@y.z>' })).toBe(await messageIdHash({ messageId: '<x@y.z>' }));
    expect(await messageIdHash({ messageId: '<x@y.z>' })).not.toBe(await messageIdHash({ messageId: '<w@y.z>' }));
  });

  it('falls back when Message-ID is missing', async () => {
    const a = await messageIdHash(fallback);
    expect(await messageIdHash({ ...fallback, from: 'alice@example.com' })).toBe(a);
    expect(await messageIdHash({ ...fallback, subject: 'Other' })).not.toBe(a);
    expect(a).not.toBe(await messageIdHash({ messageId: 'x@y' }));
  });

  it('keeps a Message-ID from colliding with a fallback', async () => {
    const forged = await messageIdHash({ messageId: JSON.stringify([fallback.from.toLowerCase(), fallback.dateISO, fallback.subject]) });
    expect(forged).not.toBe(await messageIdHash(fallback));
  });

  it('rejects an empty Message-ID', async () => {
    await expect(messageIdHash({ messageId: '' })).rejects.toThrow(TypeError);
    await expect(messageIdHash({ messageId: '  <>  ' })).rejects.toThrow(TypeError);
  });
});
