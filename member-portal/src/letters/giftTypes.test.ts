import { describe, it, expect } from 'vitest';
import { letterTreatment } from './giftTypes';

const lists = {
  acknowledgedGiftTypes: ['Donation', 'Membership'],
  separateGiftTypes: ['Donor Advised Fund'],
  excludedGiftTypes: ['Event Ticket'],
};

describe('letterTreatment', () => {
  it.each([
    ['Donation', 'acknowledged'],
    [' donation ', 'acknowledged'],
    ['donor-advised  fund', 'separate'],
    ['event ticket', 'excluded'],
    ['Driver Training', 'unlisted'],
    ['', 'unlisted'],
    ['   ', 'unlisted'],
  ])('%j → %s', (giftType, treatment) => {
    expect(letterTreatment(lists, giftType)).toBe(treatment);
  });
});
