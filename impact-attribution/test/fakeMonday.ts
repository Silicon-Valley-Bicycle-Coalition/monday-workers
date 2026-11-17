// An in-memory Monday GraphQL endpoint for the client tests: a fetch function that answers the
// queries src/monday/client.ts sends. Dispatches on the operation text, so a query the client
// changes shape on fails loudly here instead of returning something plausible. Adapted from
// contact-roles' fake: connect cells carry each linked item's board, and it answers items(ids),
// create_item and create_update.

export interface FakeColumn { id: string; title: string; type: string }
export interface FakeLink { id: string; board: string }
// Per-column cell: text for status/date/numbers/text, linked items for board_relation.
export interface FakeCell { text?: string | null; linked?: FakeLink[] }
export interface FakeItem { id: string; name?: string; state?: string; cells: Record<string, FakeCell> }
export interface FakeBoard { id: string; columns: FakeColumn[]; items: FakeItem[] }

export interface FakeCreate { boardId: string; itemName: string; values: Record<string, unknown> }
export interface FakeRequest { query: string; variables: Record<string, any> }

interface Rule { column_id: string; compare_value: unknown[]; operator: string }
interface Params { operator?: string; rules?: Rule[] }

export class FakeMonday {
  readonly boards = new Map<string, FakeBoard>();
  readonly creates: FakeCreate[] = [];
  readonly updates: { itemId: string; body: string }[] = [];
  readonly requests: FakeRequest[] = [];
  readonly queryParams: unknown[] = [];
  pageSize = 500;
  private nextId = 5000;

  addBoard(board: FakeBoard): void { this.boards.set(board.id, board); }

  readonly fetchFn: typeof fetch = async (_input, init) => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, any> };
    this.requests.push({ query, variables });
    return new Response(JSON.stringify({ data: this.answer(query, variables) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  private board(id: unknown): FakeBoard {
    const b = this.boards.get(String(Array.isArray(id) ? id[0] : id));
    if (b === undefined) throw new Error(`fake: no board ${String(id)}`);
    return b;
  }

  private answer(query: string, v: Record<string, any>): unknown {
    if (query.includes('create_item')) {
      const id = String(this.nextId++);
      this.creates.push({ boardId: String(v.boardId), itemName: String(v.itemName), values: JSON.parse(String(v.values)) });
      return { create_item: { id } };
    }
    if (query.includes('create_update')) {
      this.updates.push({ itemId: String(v.itemId), body: String(v.body) });
      return { create_update: { id: String(this.nextId++) } };
    }
    if (query.includes('items_page_by_column_values')) {
      // Exact match on the item name, as Monday's lookup is.
      const columns = v.columns as { column_id: string; column_values: string[] }[];
      if (columns.length !== 1 || columns[0]!.column_id !== 'name') throw new Error('fake: only a name lookup is supported');
      const wanted = new Set(columns[0]!.column_values);
      const items = this.board(v.boardId).items.filter((i) => wanted.has(i.name ?? `item ${i.id}`));
      return { items_page_by_column_values: { cursor: null, items: items.map((i) => ({ id: i.id, name: i.name ?? `item ${i.id}` })) } };
    }
    if (query.includes('next_items_page')) {
      const [boardId, start, params] = JSON.parse(String(v.cursor)) as [string, number, Params | null];
      return { next_items_page: this.page(this.board(boardId), start, v.columnIds as string[], params) };
    }
    if (query.includes('items_page')) {
      this.queryParams.push(v.query ?? null);
      return { boards: [{ items_page: this.page(this.board(v.boardId), 0, v.columnIds as string[], (v.query as Params | null) ?? null) }] };
    }
    if (query.includes('items(ids')) {
      const wanted = new Set((v.ids as string[]).map(String));
      const found = [...this.boards.values()].flatMap((b) => b.items).filter((i) => wanted.has(i.id));
      return { items: found.map((i) => ({ id: i.id, name: i.name ?? `item ${i.id}`, state: i.state ?? 'active' })) };
    }
    if (query.includes('columns')) {
      const board = this.board(v.boardId);
      return { boards: [{ id: board.id, columns: board.columns.map((c) => ({ id: c.id, title: c.title, type: c.type, settings_str: '{}' })) }] };
    }
    throw new Error(`fake: unrecognised query ${query.slice(0, 60)}`);
  }

  private matches(item: FakeItem, params: Params | null): boolean {
    return (params?.rules ?? []).every((r) => {
      if (r.operator !== 'is_not_empty') throw new Error(`fake: unsupported operator ${r.operator}`);
      const cell = item.cells[r.column_id];
      return (cell?.linked?.length ?? 0) > 0 || (cell?.text ?? '') !== '';
    });
  }

  private page(board: FakeBoard, start: number, columnIds: string[], params: Params | null) {
    if (!Array.isArray(columnIds)) throw new Error('fake: page request sent no columnIds');
    const all = board.items.filter((i) => this.matches(i, params));
    const slice = all.slice(start, start + this.pageSize);
    const next = start + this.pageSize < all.length ? JSON.stringify([board.id, start + this.pageSize, params]) : null;
    return {
      cursor: next,
      items: slice.map((item) => ({
        id: item.id,
        column_values: columnIds.map((id) => {
          const cell = item.cells[id] ?? {};
          return {
            id, text: cell.text ?? null,
            ...(cell.linked !== undefined ? { linked_items: cell.linked.map((l) => ({ id: l.id, board: { id: l.board } })) } : {}),
          };
        }),
      })),
    };
  }
}
