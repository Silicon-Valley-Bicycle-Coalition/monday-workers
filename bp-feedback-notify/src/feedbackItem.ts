// Reads the organizer's address and the event name off the BP Request Form item itself (#66).
// The webhook body only names the item: anyone holding the URL secret could otherwise pick the
// recipient and the subject line of an SVBC-branded email.
import { mondayRequest, type TokenProvider } from './mondayApi';

export interface FeedbackBoardConfig {
  /** BP Request Form (or its sandbox mirror). An item on any other board is refused. */
  boardId: string;
  /** Text column holding the event's name; the item name is used when it's blank. */
  eventNameColumnId: string;
  /** Text column holding the organizer's address ("Preferred Email Address For Coordination"). */
  organizerEmailColumnId: string;
}

export type FeedbackItem =
  | { kind: 'ok'; eventName: string; organizerEmail: string }
  // No such item, or the token can't see it.
  | { kind: 'not-found' }
  // The item exists but isn't on the configured board — never email, never write status back.
  | { kind: 'wrong-board' }
  // On the right board, but the email column is empty or isn't one address.
  | { kind: 'no-email' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ItemsResponse {
  items: { name: string; board: { id: string } | null; column_values: { id: string; text: string | null }[] }[];
}

/** Throws on a Monday API failure, so the caller can answer with a retryable status. */
export async function readFeedbackItem(config: FeedbackBoardConfig, token: string | TokenProvider, itemId: number): Promise<FeedbackItem> {
  const data = await mondayRequest<ItemsResponse>(
    token,
    `query ($itemIds: [ID!], $columnIds: [String!]) {
      items(ids: $itemIds) { name board { id } column_values(ids: $columnIds) { id text } }
    }`,
    { itemIds: [String(itemId)], columnIds: [config.eventNameColumnId, config.organizerEmailColumnId] },
  );
  const item = data.items[0];
  if (!item) return { kind: 'not-found' };
  if (item.board?.id !== config.boardId) return { kind: 'wrong-board' };

  const text = (columnId: string) => (item.column_values.find((c) => c.id === columnId)?.text ?? '').trim();
  const organizerEmail = text(config.organizerEmailColumnId);
  if (!EMAIL_RE.test(organizerEmail)) return { kind: 'no-email' };
  return { kind: 'ok', eventName: text(config.eventNameColumnId) || item.name.trim(), organizerEmail };
}
