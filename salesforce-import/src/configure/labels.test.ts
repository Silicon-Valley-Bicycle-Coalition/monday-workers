import { describe, it, expect } from 'vitest';
import { resolveLabelId } from './labels.js';

describe('resolveLabelId', () => {
  it('resolves a status label by text from an id-keyed object, ids need not be sequential', () => {
    const settingsStr = JSON.stringify({ labels: { '4': 'Elected Official', '19': 'City or Agency Staff' } });
    expect(resolveLabelId('status', settingsStr, 'City or Agency Staff')).toBe(19);
    expect(resolveLabelId('status', settingsStr, 'Elected Official')).toBe(4);
  });

  it('resolves a dropdown label by name from an array of {id, name}', () => {
    const settingsStr = JSON.stringify({ labels: [{ id: 1, name: 'Social Media' }, { id: 4, name: 'Posters' }] });
    expect(resolveLabelId('dropdown', settingsStr, 'Posters')).toBe(4);
  });

  it('returns undefined for an unknown label', () => {
    const settingsStr = JSON.stringify({ labels: { '0': 'Active' } });
    expect(resolveLabelId('status', settingsStr, 'Nonexistent')).toBeUndefined();
  });

  it('returns undefined rather than throwing on malformed settings_str', () => {
    expect(resolveLabelId('status', 'not json', 'Active')).toBeUndefined();
  });

  it('returns undefined for column types with no label concept', () => {
    expect(resolveLabelId('text', '{}', 'Active')).toBeUndefined();
  });
});
