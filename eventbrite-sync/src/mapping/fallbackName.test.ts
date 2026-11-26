import { describe, it, expect } from 'vitest';
import { fallbackItemName, isFallbackItemName } from './fallbackName';

describe('isFallbackItemName', () => {
  it('recognizes the name fallbackItemName gives', () => expect(isFallbackItemName(fallbackItemName('123'))).toBe(true));
  it.each([['Pat Rider'], ['Eventbrite attendee Pat'], ['']])('keeps "%s"', (name) => expect(isFallbackItemName(name)).toBe(false));
});
