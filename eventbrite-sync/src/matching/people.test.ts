import { describe, it, expect, vi } from 'vitest';
import { matchPerson } from './people';
import type { MondayClient } from '../monday/client';
import { MondayApiError } from '../monday/graphql';

function fakeClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemByColumnValue: vi.fn().mockResolvedValue(null),
    createItem: vi.fn().mockResolvedValue({ id: 'new' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    getItems: vi.fn().mockResolvedValue([]),
    postUpdate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('matchPerson names', () => {
  const who = { email: 'a@example.com', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace' };
  const nameColumns = { first: 'first_col', last: 'last_col' };

  it('writes both names after the create, leaving the create and item name as they were', async () => {
    const client = fakeClient();
    await matchPerson(client, 42, 'email_col', who, nameColumns);
    expect(client.createItem).toHaveBeenCalledWith(42, 'Ada Lovelace', { email_col: { email: 'a@example.com', text: 'a@example.com' } });
    expect(client.changeColumnValues).toHaveBeenCalledWith(42, 'new', { first_col: 'Ada', last_col: 'Lovelace' });
  });

  it('omits a blank part, treating spaces as blank', async () => {
    const client = fakeClient();
    await matchPerson(client, 42, 'email_col', { ...who, firstName: '   ', lastName: ' Lovelace ' }, nameColumns);
    expect(client.changeColumnValues).toHaveBeenCalledWith(42, 'new', { last_col: 'Lovelace' });
  });

  it('makes no name write when the source has neither part', async () => {
    const client = fakeClient();
    await matchPerson(client, 42, 'email_col', { email: 'a@example.com', name: 'Ada' }, nameColumns);
    expect(client.changeColumnValues).not.toHaveBeenCalled();
  });

  it('makes no name write without nameColumns, as for the attendee path', async () => {
    const client = fakeClient();
    await matchPerson(client, 42, 'email_col', who);
    expect(client.changeColumnValues).not.toHaveBeenCalled();
  });

  it('never writes names on a matched person', async () => {
    const client = fakeClient({ findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'p1' }) });
    await matchPerson(client, 42, 'email_col', who, nameColumns);
    expect(client.changeColumnValues).not.toHaveBeenCalled();
  });

  it('still returns the person when the name write fails, logging the id and not the name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new MondayApiError('column_values rejected: Ada', { httpStatus: 200, code: 'ColumnValueException' });
    const client = fakeClient({ changeColumnValues: vi.fn().mockRejectedValue(failure) });

    expect(await matchPerson(client, 42, 'email_col', who, nameColumns)).toEqual({ donorItemId: 'new', created: true });

    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('new');
    expect(logged).toContain('ColumnValueException');
    expect(logged).not.toContain('Ada');
    warn.mockRestore();
  });
});

describe('matchPerson', () => {
  it('returns no match, without a Monday call, when there is no email', async () => {
    const client = fakeClient();
    expect(await matchPerson(client, 42, 'email_col', { email: '  ', name: 'Jane' })).toEqual({ donorItemId: null, reason: 'no email' });
    expect(client.findItemByColumnValue).not.toHaveBeenCalled();
  });

  it('matches an existing item by the trimmed email', async () => {
    const client = fakeClient({ findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'p1' }) });
    expect(await matchPerson(client, 42, 'email_col', { email: ' a@example.com ', name: 'A' })).toEqual({ donorItemId: 'p1', created: false });
    expect(client.findItemByColumnValue).toHaveBeenCalledWith(42, 'email_col', 'a@example.com');
  });

  it('creates the person with the { email, text } shape when nothing matches', async () => {
    const client = fakeClient();
    expect(await matchPerson(client, 42, 'email_col', { email: 'a@example.com', name: ' Ann ' })).toEqual({ donorItemId: 'new', created: true });
    expect(client.createItem).toHaveBeenCalledWith(42, 'Ann', { email_col: { email: 'a@example.com', text: 'a@example.com' } });
  });
});
