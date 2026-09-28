import { describe, expect, it } from 'vitest';
import { redactEmails } from './redactEmails';

describe('redactEmails', () => {
  it('removes the known recipient, case-insensitively and every time it appears', () => {
    expect(redactEmails('to Organizer@Example.org failed (organizer@example.org)', ['organizer@example.org'])).toBe(
      'to [redacted] failed ([redacted])'
    );
  });

  it('removes a known address even when it is not a typical address shape', () => {
    expect(redactEmails('bad recipient: weird+tag@localhost', ['weird+tag@localhost'])).toBe('bad recipient: [redacted]');
  });

  it('removes any other address-shaped text too', () => {
    expect(redactEmails('destination address <someone.else@example.com> is not a verified address', [])).toBe(
      'destination address <[redacted]> is not a verified address'
    );
  });

  it('leaves a message with no addresses alone', () => {
    expect(redactEmails('rate limited', ['organizer@example.org'])).toBe('rate limited');
  });
});
