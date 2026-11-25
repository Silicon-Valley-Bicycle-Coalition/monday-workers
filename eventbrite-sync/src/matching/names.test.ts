import { describe, it, expect } from 'vitest';
import { nameParts } from './names';

describe('nameParts', () => {
  it('uses the separate parts as given, trimmed', () => {
    expect(nameParts({ firstName: ' Mary Ann ', lastName: ' de la Cruz ', name: 'Mary Ann de la Cruz' })).toEqual({ firstName: 'Mary Ann', lastName: 'de la Cruz' });
  });

  it('takes the last name from what follows a known first name', () => {
    expect(nameParts({ firstName: 'Mary Ann', lastName: null, name: 'Mary Ann de la Cruz' })).toEqual({ firstName: 'Mary Ann', lastName: 'de la Cruz' });
  });

  it.each([['Annette Rider'], ['Rider, Ann'], ['Ann'], [null]])('leaves the last name blank when "%s" does not start with the first name "Ann"', (name) => {
    expect(nameParts({ firstName: 'Ann', name })).toEqual({ firstName: 'Ann', lastName: null });
  });

  it('keeps a lone last name without guessing a first', () => {
    expect(nameParts({ firstName: '', lastName: 'Rider', name: 'Rider' })).toEqual({ firstName: null, lastName: 'Rider' });
  });

  it.each([
    ['Pat Rider', 'Pat', 'Rider'],
    ['  Pat   Rider ', 'Pat', 'Rider'],
    ['José Núñez', 'José', 'Núñez'],
    ["D'Arcy O'Neil", "D'Arcy", "O'Neil"],
    ['Anne-Marie Rider', 'Anne-Marie', 'Rider'],
  ])('splits a two-word name: %s', (name, firstName, lastName) => {
    expect(nameParts({ name })).toEqual({ firstName, lastName });
  });

  it('takes only the first word of a longer name, whose last name could start anywhere', () => {
    expect(nameParts({ name: 'Juan Carlos de la Cruz' })).toEqual({ firstName: 'Juan', lastName: null });
  });

  it('leaves the last name blank when the second word is not plainly a name', () => {
    expect(nameParts({ name: 'Pat R.' })).toEqual({ firstName: 'Pat', lastName: null });
  });

  it('takes a one-word name as the first name', () => {
    expect(nameParts({ name: 'Pat' })).toEqual({ firstName: 'Pat', lastName: null });
  });

  it.each([['Rider, Pat'], ['Dr. Pat Rider'], ['Dr Pat Rider'], ['Mrs Rider'], ['J Rider'], ['J. Rider'], ['pat@example.com'], ['Pat2 Rider'], ['李 伟'], ['']])(
    'leaves both blank when the first word is not plainly a first name: "%s"',
    (name) => {
      expect(nameParts({ name })).toEqual({ firstName: null, lastName: null });
    }
  );

  it.each([
    [{ firstName: 'Info Requested', lastName: 'Info Requested', name: 'Info Requested Info Requested' }, { firstName: null, lastName: null }],
    [{ firstName: 'Pat', lastName: 'Info Requested', name: 'Pat Info Requested' }, { firstName: 'Pat', lastName: null }],
    [{ name: 'Info Requested' }, { firstName: null, lastName: null }],
    [{ firstName: 'Info Requested', name: 'Pat Rider' }, { firstName: 'Pat', lastName: 'Rider' }],
  ])('never returns an Eventbrite placeholder: %j', (who, expected) => {
    expect(nameParts(who)).toEqual(expected);
  });

  it('never returns a placeholder that only a split would expose', () => {
    expect(nameParts({ name: 'Info Requested Rider' })).toEqual({ firstName: null, lastName: null });
  });
});
