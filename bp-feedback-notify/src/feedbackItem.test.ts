import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFeedbackItem, type FeedbackBoardConfig } from './feedbackItem';

const CONFIG: FeedbackBoardConfig = {
  boardId: '18395469629',
  eventNameColumnId: 'short_textdqu5gf2d',
  organizerEmailColumnId: 'short_text3z8szxke',
};

function stubItems(items: unknown[] | Error | Response) {
  const fetchMock = vi.fn(async () => {
    if (items instanceof Error) throw items;
    if (items instanceof Response) return items;
    return new Response(JSON.stringify({ data: { items } }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const STATUS_COLUMN = 'color_status';
const GUARD = { columnId: STATUS_COLUMN, sentLabel: 'Sent to Organizer' };

function item({ status = '', board = CONFIG.boardId, email = 'organizer@example.org', event = 'Fall Festival', name = 'Item name' } = {}) {
  return {
    name,
    board: { id: board },
    column_values: [
      { id: CONFIG.eventNameColumnId, text: event },
      { id: CONFIG.organizerEmailColumnId, text: email },
      { id: STATUS_COLUMN, text: status },
    ],
  };
}

describe('readFeedbackItem', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the organizer address and event name off the item', async () => {
    const fetchMock = stubItems([item({ email: '  organizer@example.org ' })]);
    expect(await readFeedbackItem(CONFIG, 'token', 42)).toEqual({ kind: 'ok', eventName: 'Fall Festival', organizerEmail: 'organizer@example.org' });

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get('Authorization')).toBe('token');
    const { variables } = JSON.parse(init.body as string);
    expect(variables).toEqual({ itemIds: ['42'], columnIds: [CONFIG.eventNameColumnId, CONFIG.organizerEmailColumnId] });
  });

  it('falls back to the item name when the event-name column is blank', async () => {
    stubItems([item({ event: '  ', name: 'Downtown Jazz Night' })]);
    expect(await readFeedbackItem(CONFIG, 'token', 42)).toMatchObject({ kind: 'ok', eventName: 'Downtown Jazz Night' });
  });

  it('reports not-found when Monday returns no item', async () => {
    stubItems([]);
    expect(await readFeedbackItem(CONFIG, 'token', 42)).toEqual({ kind: 'not-found' });
  });

  it('refuses an item on any other board, even with a valid address', async () => {
    stubItems([item({ board: '99999' })]);
    expect(await readFeedbackItem(CONFIG, 'token', 42)).toEqual({ kind: 'wrong-board' });
  });

  it.each(['', 'not-an-email', 'a@example.org, b@example.org', 'a@example.org\r\nBcc: b@example.org'])(
    'reports no-email for an email column of %j',
    async (email) => {
      stubItems([item({ email })]);
      expect(await readFeedbackItem(CONFIG, 'token', 42)).toEqual({ kind: 'no-email' });
    },
  );

  it('reports already-sent when the status column holds the sent label (#105)', async () => {
    const fetchMock = stubItems([item({ status: 'Sent to Organizer' })]);
    expect(await readFeedbackItem(CONFIG, 'token', 42, GUARD)).toEqual({ kind: 'already-sent' });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).variables.columnIds).toContain(STATUS_COLUMN);
  });

  it.each(['', 'Ready to Send', 'Send Failed'])('still reads the item when the status is %j', async (status) => {
    stubItems([item({ status })]);
    expect(await readFeedbackItem(CONFIG, 'token', 42, GUARD)).toMatchObject({ kind: 'ok' });
  });

  it('ignores the status column without a guard', async () => {
    const fetchMock = stubItems([item({ status: 'Sent to Organizer' })]);
    expect(await readFeedbackItem(CONFIG, 'token', 42)).toMatchObject({ kind: 'ok' });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).variables.columnIds).not.toContain(STATUS_COLUMN);
  });

  it('throws on a Monday API failure so the webhook can answer with a retryable status', async () => {
    stubItems(new Response(JSON.stringify({ errors: [{ message: 'Complexity budget exhausted' }] }), { status: 200 }));
    await expect(readFeedbackItem(CONFIG, 'token', 42)).rejects.toThrow('Complexity budget exhausted');
  });
});
