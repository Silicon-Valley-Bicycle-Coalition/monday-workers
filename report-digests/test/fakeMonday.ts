import { MAX_ITEMS, type Board, type DigestsMondayClient, type Item, type LinkedItem, type MondayUser, type Rule } from '../src/monday/client';

export const DONATIONS: Board = {
  id: '18437342657', name: 'Donations',
  columns: [
    ['amount', 'Amount'], ['date', 'Date'], ['status', 'Status'], ['gift_type', 'Gift Type'], ['donor', 'Donor'],
    ['anon', 'Anonymous Donor'], ['stream', 'Funding Stream'], ['size', 'Gift Size'], ['thanked', 'Thank You Sent'],
  ].map(([id, title]) => ({ id: id!, title: title!, type: 'text' })),
  views: [{ id: '901', name: 'Needs a donor' }, { id: '902', name: 'Gifts, last 7 days' }],
};

export const PEOPLE: Board = {
  id: '18437342592', name: 'People',
  columns: [['email', 'Personal Email'], ['phone', 'Phone'], ['ms', 'Membership Status'], ['tier', 'Membership Tier'], ['until', 'Member Until']]
    .map(([id, title]) => ({ id: id!, title: title!, type: 'text' })),
  views: [],
};

export function item(id: string, name: string, text: Record<string, string>, linked: Record<string, string[]> = {}): Item {
  return { id, name, text: new Map(Object.entries(text)), linked: new Map(Object.entries(linked)) };
}

export class FakeMonday implements DigestsMondayClient {
  queries: { boardId: number; rules: Rule[]; columnIds: string[]; paged: boolean }[] = [];
  donorLookups: { ids: string[]; titles: string[] }[] = [];
  constructor(
    private items: Item[] = [],
    private donors: LinkedItem[] = [],
    private users: MondayUser[] = [],
    private boards: Board[] = [DONATIONS, PEOPLE],
  ) {}
  async getBoard(boardId: number) { return this.boards.find((b) => Number(b.id) === boardId) ?? null; }
  // Mirrors HttpMondayClient: queryItems refuses past MAX_ITEMS; itemPages streams any number.
  async queryItems(boardId: number, rules: Rule[], columnIds: string[]) {
    this.queries.push({ boardId, rules, columnIds, paged: false });
    if (this.items.length > MAX_ITEMS) throw new Error(`board ${boardId}: filter matched more than ${MAX_ITEMS} items`);
    return this.items;
  }
  async *itemPages(boardId: number, rules: Rule[], columnIds: string[]) {
    this.queries.push({ boardId, rules, columnIds, paged: true });
    for (let i = 0; i < this.items.length; i += 500) yield this.items.slice(i, i + 500);
  }
  async getItemsByTitle(ids: string[], titles: string[]) {
    this.donorLookups.push({ ids, titles });
    return this.donors.filter((d) => ids.includes(d.id))
      .map((d) => ({ ...d, byTitle: new Map(titles.map((t) => [t, d.byTitle.get(t) ?? null])) }));
  }
  async getUsers(ids: number[]) { return this.users.filter((u) => ids.includes(Number(u.id))); }
}
