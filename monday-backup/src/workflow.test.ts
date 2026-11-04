import { describe, expect, it, vi } from 'vitest';
import { env, introspectWorkflowInstance } from 'cloudflare:test';
import { NonRetryableError } from 'cloudflare:workflows';
import { asSnapshotStep, isUnretryable } from './workflow';
import { MondayApiError } from './monday/graphql';
import type { WorkflowStep } from 'cloudflare:workers';

const passthrough = { do: vi.fn(async (_name: string, _config: unknown, fn: () => Promise<unknown>) => fn()) } as unknown as WorkflowStep;

describe('asSnapshotStep', () => {
  it('passes results through, with the retry policy on every step', async () => {
    await expect(asSnapshotStep(passthrough).do('board 1', async () => 42)).resolves.toBe(42);
    expect((passthrough.do as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'board 1',
      { retries: { limit: 2, delay: '1 minute', backoff: 'exponential' }, timeout: '30 minutes' },
    ]);
  });

  it("doesn't retry Monday's daily limit, which no retry within a run can clear", async () => {
    const daily = new MondayApiError('monday API: over the limit', { code: 'DAILY_LIMIT_EXCEEDED' });
    expect(isUnretryable(daily)).toBe(true);
    await expect(
      asSnapshotStep(passthrough).do('board 1', async () => {
        throw daily;
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('leaves other failures for the retry policy', async () => {
    const other = new MondayApiError('monday API: exhausted 5 attempts', { httpStatus: 503 });
    expect(isUnretryable(other)).toBe(false);
    expect(isUnretryable(new Error('Drive API: HTTP 500'))).toBe(false);
    await expect(
      asSnapshotStep(passthrough).do('board 1', async () => {
        throw other;
      }),
    ).rejects.toBe(other);
  });
});

describe('SnapshotWorkflow', () => {
  // Proves the class is exported and bound. Everything it does is covered in backup.test.ts.
  it('runs to completion through the real binding when the switch is off', async () => {
    const id = 'smoke';
    const instance = await introspectWorkflowInstance(env.SNAPSHOT, id);
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: 'start' }, null);
    });
    await env.SNAPSHOT.create({ id });
    await expect(instance.waitForStatus('complete')).resolves.not.toThrow();
    await instance.dispose();
  });
});
