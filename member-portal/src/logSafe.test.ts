import { describe, expect, it } from 'vitest';
import { errorText, redactEmails } from './logSafe';

describe('redactEmails', () => {
  it('replaces every address', () => {
    expect(redactEmails('E_RECIPIENT_NOT_ALLOWED: Donor@Example.org, second <x@y.co>')).toBe(
      'E_RECIPIENT_NOT_ALLOWED: <email>, second <<email>>',
    );
  });

  it('leaves text without an address alone', () => {
    expect(redactEmails('D1_ERROR: no such table @ sessions')).toBe('D1_ERROR: no such table @ sessions');
  });
});

describe('errorText', () => {
  it('redacts an Error message and a non-Error value alike', () => {
    expect(errorText(new Error('send to a@b.com failed'))).toBe('send to <email> failed');
    expect(errorText('bad a@b.com')).toBe('bad <email>');
  });
});
