import { describe, it, expect } from 'vitest';
import { errorText, redactEmails } from './logSafe';

describe('redactEmails', () => {
  it('replaces every address and leaves the rest of the text', () => {
    expect(redactEmails('a@b.org is already on the board (also C.D@ex.co.uk)')).toBe(
      '<email redacted> is already on the board (also <email redacted>)',
    );
  });

  it('is a no-op without an address', () => {
    expect(redactEmails('item 123 moved')).toBe('item 123 moved');
  });
});

describe('errorText', () => {
  it('takes an Error message or stringifies anything else', () => {
    expect(errorText(new Error('boom x@y.io'))).toBe('boom <email redacted>');
    expect(errorText(42)).toBe('42');
  });
});
