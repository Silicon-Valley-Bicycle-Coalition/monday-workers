import type { Board, DigestsMondayClient, Item, LinkedItem, MondayUser, Rule } from '../src/monday/client';

export const DONATIONS: Board = {
  id: '18437342657', name: 'Donations',
  columns: [
    ['amount', 'Amount'], ['date', 'Date'], ['status', 'Status'], ['gift_type', 'Gift Type'], ['donor', 'Donor'],
    ['anon', 'Anonymous Donor'], ['stream', 'Funding Stream'], ['size', 'Gift Size'],
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
  queries: { boardId: number; rules: Rule[] }[] = [];
  constructor(
    private items: Item[] = [],
    private donors: LinkedItem[] = [],
    private users: MondayUser[] = [],
    private boards: Board[] = [DONATIONS, PEOPLE],
  ) {}
  async getBoard(boardId: number) { return this.boards.find((b) => Number(b.id) === boardId) ?? null; }
  async queryItems(boardId: number, rules: Rule[]) { this.queries.push({ boardId, rules }); return this.items; }
  async getItemsByTitle(ids: string[]) { return this.donors.filter((d) => ids.includes(d.id)); }
  async getUsers(ids: number[]) { return this.users.filter((u) => ids.includes(Number(u.id))); }
}
