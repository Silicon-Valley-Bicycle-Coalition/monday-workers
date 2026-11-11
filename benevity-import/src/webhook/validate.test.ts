import { describe, it, expect } from 'vitest';
import { isChallenge, validateRetryEvent, validateUploadEvent } from './validate';

describe('isChallenge', () => {
  it('recognizes a subscribe handshake payload', () => {
    expect(isChallenge({ challenge: 'abc123' })).toBe(true);
  });

  it('rejects a real event payload', () => {
    expect(isChallenge({ event: { pulseId: 1 } })).toBe(false);
  });
});

describe('validateUploadEvent', () => {
  it('extracts the item id, changed column id, and asset ids from a file-column-change event', () => {
    const body = {
      event: {
        pulseId: 12345,
        boardId: 777,
        columnId: 'file_col',
        value: { files: [{ assetId: 999, name: 'report.csv' }] },
      },
    };
    expect(validateUploadEvent(body)).toEqual({ itemId: '12345', columnId: 'file_col', boardId: '777', assetIds: ['999'] });
  });

  it('collects multiple asset ids when more than one file was dropped at once', () => {
    const body = {
      event: { pulseId: 1, boardId: 7, columnId: 'file_col', value: { files: [{ assetId: 1 }, { assetId: 2 }] } },
    };
    expect(validateUploadEvent(body)).toEqual({ itemId: '1', columnId: 'file_col', boardId: '7', assetIds: ['1', '2'] });
  });

  it('rejects an event without a boardId', () => {
    expect(() =>
      validateUploadEvent({ event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 1 }] } } })
    ).toThrow(/missing "boardId"/);
  });

  it('throws when the payload has no event', () => {
    expect(() => validateUploadEvent({})).toThrow(/missing "event"/);
  });

  it('throws when the event has no file assetIds', () => {
    expect(() => validateUploadEvent({ event: { pulseId: 1, boardId: 7, columnId: 'file_col', value: {} } })).toThrow(/no file assetIds/);
  });

  it('throws when the event has no columnId', () => {
    expect(() => validateUploadEvent({ event: { pulseId: 1, boardId: 7, value: { files: [{ assetId: 1 }] } } })).toThrow(/missing "columnId"/);
  });
});

describe('validateRetryEvent', () => {
  it('extracts the item id, column id, and new status label from a status-column-change event', () => {
    const body = {
      event: {
        pulseId: 4242,
        columnId: 'retry_col',
        value: { label: { index: 1, text: 'Retry', style: {}, is_done: false }, post_id: null },
        previousValue: { label: { index: 0, text: 'Needs review' } },
      },
    };
    expect(validateRetryEvent(body)).toEqual({ itemId: '4242', columnId: 'retry_col', label: 'Retry' });
  });

  it('reads a cleared status column as an empty label', () => {
    expect(validateRetryEvent({ event: { pulseId: '1', columnId: 'c', value: null } })).toEqual({
      itemId: '1',
      columnId: 'c',
      label: '',
    });
  });

  it('rejects a payload without pulseId or columnId', () => {
    expect(() => validateRetryEvent({ event: { columnId: 'c' } })).toThrow(/pulseId/);
    expect(() => validateRetryEvent({ event: { pulseId: 1 } })).toThrow(/columnId/);
    expect(() => validateRetryEvent({})).toThrow(/event/);
  });
});
