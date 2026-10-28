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

function item({ board = CONFIG.boardId, email = 'organizer@example.org', event = 'Fall Festival', name = 'Item name' } = {}) {
  return {
    name,
    board: { id: board },
    column_values: [
      { id: CONFIG.eventNameColumnId, text: event },
      { id: CONFIG.organizerEmailColumnId, text: email },
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

  it('throws on a Monday API failure so the webhook can answer with a retryable status', async () => {
    stubItems(new Response(JSON.stringify({ errors: [{ message: 'Complexity budget exhausted' }] }), { status: 200 }));
    await expect(readFeedbackItem(CONFIG, 'token', 42)).rejects.toThrow('Complexity budget exhausted');
  });
});
