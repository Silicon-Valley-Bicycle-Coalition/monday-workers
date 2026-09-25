import { describe, it, expect, vi } from 'vitest';
import { chunkForSendBatch, sendInBatches, MAX_BATCH_MESSAGES, MAX_BATCH_BYTES } from './sendBatch';

describe('chunkForSendBatch', () => {
  it('returns no chunks for no messages', () => {
    expect(chunkForSendBatch([])).toEqual([]);
  });

  it('splits at 100 messages per chunk', () => {
    const messages = Array.from({ length: 250 }, (_, i) => ({ transactionId: `TXN${i}` }));
    const chunks = chunkForSendBatch(messages);
    expect(chunks.map((c) => c.length)).toEqual([MAX_BATCH_MESSAGES, MAX_BATCH_MESSAGES, 50]);
    expect(chunks.flat()).toEqual(messages);
  });

  it('also splits before a chunk would exceed the 256 KB batch size limit', () => {
    // 10 messages of ~60 KB each: at most 4 fit under 256 KB.
    const big = 'x'.repeat(60 * 1024);
    const messages = Array.from({ length: 10 }, (_, i) => ({ transactionId: `${i}${big}` }));
    const chunks = chunkForSendBatch(messages);
    for (const chunk of chunks) {
      const bytes = chunk.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
      expect(bytes).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
    expect(chunks.flat()).toEqual(messages);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });
});

describe('sendInBatches', () => {
  it('calls sendBatch once per chunk, in order, and not at all for no messages', async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    await sendInBatches({ sendBatch }, []);
    expect(sendBatch).not.toHaveBeenCalled();

    const messages = Array.from({ length: 101 }, (_, i) => ({ transactionId: `TXN${i}` }));
    await sendInBatches({ sendBatch }, messages);
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(sendBatch.mock.calls[0]![0]).toHaveLength(100);
    expect(sendBatch.mock.calls[1]![0]).toEqual([{ transactionId: 'TXN100' }]);
  });
});
