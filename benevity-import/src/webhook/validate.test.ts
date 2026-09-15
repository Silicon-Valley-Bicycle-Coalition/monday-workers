import { describe, it, expect } from 'vitest';
import { isChallenge, validateUploadEvent } from './validate';

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
        columnId: 'file_col',
        value: { files: [{ assetId: 999, name: 'report.csv' }] },
      },
    };
    expect(validateUploadEvent(body)).toEqual({ itemId: '12345', columnId: 'file_col', assetIds: ['999'] });
  });

  it('collects multiple asset ids when more than one file was dropped at once', () => {
    const body = {
      event: { pulseId: 1, columnId: 'file_col', value: { files: [{ assetId: 1 }, { assetId: 2 }] } },
    };
    expect(validateUploadEvent(body)).toEqual({ itemId: '1', columnId: 'file_col', assetIds: ['1', '2'] });
  });

  it('throws when the payload has no event', () => {
    expect(() => validateUploadEvent({})).toThrow(/missing "event"/);
  });

  it('throws when the event has no file assetIds', () => {
    expect(() => validateUploadEvent({ event: { pulseId: 1, columnId: 'file_col', value: {} } })).toThrow(/no file assetIds/);
  });

  it('throws when the event has no columnId', () => {
    expect(() => validateUploadEvent({ event: { pulseId: 1, value: { files: [{ assetId: 1 }] } } })).toThrow(/missing "columnId"/);
  });
});
