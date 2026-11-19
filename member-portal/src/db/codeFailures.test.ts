import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1CodeFailureStore } from './codeFailures';
import { D1MagicLinkTokenStore } from './tokens';

const NOW = '2026-11-18T09:00:00.000Z';
const BUDGET = { sinceISO: '2026-11-17T09:00:00.000Z', max: 1 };

describe('D1CodeFailureStore', () => {
  it('frees a slot when it is released', async () => {
    const tokens = new D1MagicLinkTokenStore(env.DB);
    const failures = new D1CodeFailureStore(env.DB);
    await tokens.createToken({
      tokenHash: 'tok-rel',
      donorItemIds: ['d'],
      expiresAt: '2026-11-18T09:15:00.000Z',
      requestHash: 'req-rel',
      codeHash: 'code-rel',
      emailHash: 'cf-rel',
    });

    const first = await tokens.takeCodeAttempt('req-rel', NOW, 5, BUDGET);
    expect(first?.failureSlot).not.toBeNull();
    expect((await tokens.takeCodeAttempt('req-rel', NOW, 5, BUDGET))?.failureSlot).toBeNull();
    await failures.releaseFailure(first!.failureSlot!);
    expect((await tokens.takeCodeAttempt('req-rel', NOW, 5, BUDGET))?.failureSlot).not.toBeNull();
  });
});
