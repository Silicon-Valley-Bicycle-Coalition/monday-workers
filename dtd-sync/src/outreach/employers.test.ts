import { describe, it, expect } from 'vitest';
import { promptVariant } from './employers';
import type { OutreachConfig } from '../config';
import { rawOutreach } from '../../test/outreach';

const cfg = rawOutreach() as OutreachConfig;
const google = cfg.matchingEmployers[0]!;

describe('promptVariant', () => {
  it.each(['Google', ' google ', 'google, llc', 'GOOGLE INC.', 'Alphabet', 'alphabet corp'])('%s is a known matcher', (name) => {
    expect(promptVariant(name, cfg)).toEqual({ kind: 'known', employer: google });
  });
  it.each(['Google Cloud', 'Goog', 'Retired', 'Self', 'N/A', 'Inc.'])('%s is not', (name) => {
    expect(promptVariant(name, cfg)).toBeNull();
  });
  it.each([null, '', '   '])('asks a donor with no employer on file (%j)', (name) => {
    expect(promptVariant(name, cfg)).toEqual({ kind: 'ask' });
  });
  it('asks nobody while employerFormUrl is null', () => {
    expect(promptVariant(null, { ...cfg, employerFormUrl: null })).toBeNull();
  });
});
