import { describe, it, expect } from 'vitest';
import { isPlaceholderAttendee, realEmail, realName } from './placeholder';

describe('realEmail', () => {
  it('rejects the placeholder', () => expect(realEmail('Info Requested')).toBeNull());
  it('trims an address', () => expect(realEmail('  pat@example.org ')).toBe('pat@example.org'));
  it('rejects blank', () => expect(realEmail('')).toBeNull());
  it('rejects a non-string', () => expect(realEmail(null)).toBeNull());
});

describe('realName', () => {
  it('rejects the placeholder full name', () => expect(realName('Info Requested Info Requested')).toBeNull());
  it('rejects the placeholder first name', () => expect(realName('Info Requested')).toBeNull());
  it('keeps a real name', () => expect(realName(' Pat Rider ')).toBe('Pat Rider'));
  it('rejects blank', () => expect(realName('  ')).toBeNull());
  it('keeps a name that only contains the words', () => expect(realName('Info Requested Smith')).toBe('Info Requested Smith'));
});

describe('isPlaceholderAttendee', () => {
  it('is true for the placeholder email', () => expect(isPlaceholderAttendee({ email: 'Info Requested' })).toBe(true));
  it('is false for a real address', () => expect(isPlaceholderAttendee({ email: 'pat@example.org' })).toBe(false));
  it('is false with no profile', () => expect(isPlaceholderAttendee(null)).toBe(false));
});
