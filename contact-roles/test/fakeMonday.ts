// An in-memory Monday GraphQL endpoint for the client tests: a fetch function that answers the
// queries src/monday/client.ts sends. Dispatches on the operation text, so a query the client
// changes shape on fails loudly here instead of returning something plausible.

export interface FakeColumn { id: string; title: string; type: string; settings?: unknown }
// Per-column cell: text for status/text, linked item ids for board_relation, labels for dropdown.
export interface FakeCell { text?: string | null; linked?: string[]; labels?: string[] }
export interface FakeItem { id: string; cells: Record<string, FakeCell> }
export interface FakeBoard { id: string; columns: FakeColumn[]; items: FakeItem[] }

export interface FakeWrite { boardId: string; itemId: string; values: Record<string, unknown> }

interface Rule { column_id: string; compare_value: unknown[]; operator: string }

export class FakeMonday {
  readonly boards = new Map<string, FakeBoard>();
  readonly writes: FakeWrite[] = [];
  // column ids asked for in each items_page query, so a test can prove a column was never read
  readonly requestedColumns: string[][] = [];
  readonly queryParams: unknown[] = [];
  pageSize = 500;

  addBoard(board: FakeBoard): void { this.boards.set(board.id, board); }

  readonly fetchFn: typeof fetch = async (_input, init) => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, any> };
    return new Response(JSON.stringify({ data: this.answer(query, variables) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  private board(id: unknown): FakeBoard {
    const b = this.boards.get(String(Array.isArray(id) ? id[0] : id));
    if (b === undefined) throw new Error(`fake: no board ${String(id)}`);
    return b;
  }

  private answer(query: string, v: Record<string, any>): unknown {
    if (query.includes('change_multiple_column_values')) {
      this.writes.push({ boardId: String(v.boardId), itemId: String(v.itemId), values: JSON.parse(String(v.values)) });
      return { change_multiple_column_values: { id: String(v.itemId) } };
    }
    if (query.includes('next_items_page')) {
      const [boardId, start, columnIds, rules] = JSON.parse(String(v.cursor)) as [string, number, string[], Rule[] | null];
      return { next_items_page: this.page(this.board(boardId), start, columnIds, rules) };
    }
    if (query.includes('items_page')) {
      const board = this.board(v.boardId);
      const rules = (v.query as { rules?: Rule[] } | null | undefined)?.rules ?? null;
      this.queryParams.push(v.query ?? null);
      return { boards: [{ items_page: this.page(board, 0, v.columnIds as string[], rules) }] };
    }
    if (query.includes('columns')) {
      const board = this.board(v.boardId);
      return { boards: [{ id: board.id, columns: board.columns.map((c) => ({ id: c.id, title: c.title, type: c.type, settings_str: JSON.stringify(c.settings ?? {}) })) }] };
    }
    throw new Error(`fake: unrecognised query ${query.slice(0, 60)}`);
  }

  private matches(item: FakeItem, rules: Rule[] | null): boolean {
    for (const r of rules ?? []) {
      if (r.operator !== 'is_not_empty') throw new Error(`fake: unsupported operator ${r.operator}`);
      const cell = item.cells[r.column_id];
      const filled = (cell?.linked?.length ?? 0) > 0 || (cell?.labels?.length ?? 0) > 0 || (cell?.text ?? '') !== '';
      if (!filled) return false;
    }
    return true;
  }

  private page(board: FakeBoard, start: number, columnIds: string[], rules: Rule[] | null) {
    this.requestedColumns.push(columnIds);
    const all = board.items.filter((i) => this.matches(i, rules));
    const slice = all.slice(start, start + this.pageSize);
    const next = start + this.pageSize < all.length ? JSON.stringify([board.id, start + this.pageSize, columnIds, rules]) : null;
    return {
      cursor: next,
      items: slice.map((item) => ({
        id: item.id,
        column_values: columnIds.map((id) => {
          const cell = item.cells[id] ?? {};
          return {
            id, text: cell.text ?? null,
            ...(cell.linked !== undefined ? { linked_item_ids: cell.linked } : {}),
            ...(cell.labels !== undefined ? { values: cell.labels.map((label, n) => ({ id: n + 1, label })) } : {}),
          };
        }),
      })),
    };
  }
}
