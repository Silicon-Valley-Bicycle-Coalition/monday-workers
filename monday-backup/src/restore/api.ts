import type { MondayGraphQL } from '../monday/graphql';
import type { ColumnDef } from '../types';

// The Monday writes a restore makes, behind an interface so the orchestrator can run against the
// real API, a dry run, or a test double.
export interface RestoreApi {
  createBoard(args: { name: string; kind: string; workspaceId: string; description: string | null }): Promise<string>;
  createColumn(args: {
    boardId: string;
    title: string;
    type: string;
    description?: string | null;
    defaults?: unknown;
    id?: string;
  }): Promise<string>;
  createGroup(args: { boardId: string; name: string; color?: string | null }): Promise<string>;
  createItem(args: { boardId: string; groupId?: string; name: string; columnValues: Record<string, unknown> }): Promise<string>;
  createSubitem(args: { parentItemId: string; name: string }): Promise<{ id: string; boardId: string }>;
  setColumnValues(args: { boardId: string; itemId: string; columnValues: Record<string, unknown> }): Promise<void>;
  createUpdate(args: { itemId: string; body: string; parentId?: string }): Promise<string>;
  archiveBoard(boardId: string): Promise<void>;
  createDoc(args: { workspaceId: string; name: string; kind: string }): Promise<string>;
  createDocBlock(args: { docId: string; type: string; content: string; afterBlockId?: string; parentBlockId?: string }): Promise<string>;
  listColumns(boardId: string): Promise<ColumnDef[]>;
}

// Real writes through the shared transport. Creates are sent with `idempotent: false`, so a
// failure that might have committed throws AmbiguousWriteError rather than risking a duplicate;
// sets and archives are safe to retry.
export class MondayRestoreApi implements RestoreApi {
  constructor(private gql: MondayGraphQL) {}

  async createBoard(args: { name: string; kind: string; workspaceId: string; description: string | null }): Promise<string> {
    const data = await this.gql.request<{ create_board: { id: string } }>(
      `mutation ($name: String!, $kind: BoardKind!, $workspaceId: ID, $description: String) {
        create_board(board_name: $name, board_kind: $kind, workspace_id: $workspaceId, description: $description, empty: true) { id }
      }`,
      args,
      { idempotent: false },
    );
    return data.create_board.id;
  }

  async createColumn(args: {
    boardId: string;
    title: string;
    type: string;
    description?: string | null;
    defaults?: unknown;
    id?: string;
  }): Promise<string> {
    const data = await this.gql.request<{ create_column: { id: string } }>(
      `mutation ($boardId: ID!, $title: String!, $type: ColumnType!, $description: String, $defaults: JSON, $id: String) {
        create_column(board_id: $boardId, title: $title, column_type: $type, description: $description, defaults: $defaults, id: $id) { id }
      }`,
      {
        boardId: args.boardId,
        title: args.title,
        type: args.type,
        description: args.description ?? null,
        defaults: args.defaults === undefined ? null : JSON.stringify(args.defaults),
        id: args.id ?? null,
      },
      { idempotent: false },
    );
    return data.create_column.id;
  }

  async createGroup(args: { boardId: string; name: string; color?: string | null }): Promise<string> {
    const data = await this.gql.request<{ create_group: { id: string } }>(
      `mutation ($boardId: ID!, $name: String!, $color: String) {
        create_group(board_id: $boardId, group_name: $name, group_color: $color) { id }
      }`,
      { boardId: args.boardId, name: args.name, color: args.color ?? null },
      { idempotent: false },
    );
    return data.create_group.id;
  }

  async createItem(args: { boardId: string; groupId?: string; name: string; columnValues: Record<string, unknown> }): Promise<string> {
    const data = await this.gql.request<{ create_item: { id: string } }>(
      `mutation ($boardId: ID!, $groupId: String, $name: String!, $values: JSON) {
        create_item(board_id: $boardId, group_id: $groupId, item_name: $name, column_values: $values, create_labels_if_missing: true) { id }
      }`,
      { boardId: args.boardId, groupId: args.groupId ?? null, name: args.name, values: JSON.stringify(args.columnValues) },
      { idempotent: false },
    );
    return data.create_item.id;
  }

  async createSubitem(args: { parentItemId: string; name: string }): Promise<{ id: string; boardId: string }> {
    const data = await this.gql.request<{ create_subitem: { id: string; board: { id: string } } }>(
      `mutation ($parent: ID!, $name: String!) {
        create_subitem(parent_item_id: $parent, item_name: $name, create_labels_if_missing: true) { id board { id } }
      }`,
      { parent: args.parentItemId, name: args.name },
      { idempotent: false },
    );
    return { id: data.create_subitem.id, boardId: data.create_subitem.board.id };
  }

  async setColumnValues(args: { boardId: string; itemId: string; columnValues: Record<string, unknown> }): Promise<void> {
    await this.gql.request(
      `mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values, create_labels_if_missing: true) { id }
      }`,
      { boardId: args.boardId, itemId: args.itemId, values: JSON.stringify(args.columnValues) },
    );
  }

  async createUpdate(args: { itemId: string; body: string; parentId?: string }): Promise<string> {
    const data = await this.gql.request<{ create_update: { id: string } }>(
      `mutation ($itemId: ID, $body: String!, $parentId: ID) {
        create_update(item_id: $itemId, body: $body, parent_id: $parentId) { id }
      }`,
      { itemId: args.parentId === undefined ? args.itemId : null, body: args.body, parentId: args.parentId ?? null },
      { idempotent: false },
    );
    return data.create_update.id;
  }

  async archiveBoard(boardId: string): Promise<void> {
    await this.gql.request(`mutation ($boardId: ID!) { archive_board(board_id: $boardId) { id } }`, { boardId });
  }

  async createDoc(args: { workspaceId: string; name: string; kind: string }): Promise<string> {
    const data = await this.gql.request<{ create_doc: { id: string } }>(
      `mutation ($workspaceId: ID!, $name: String!, $kind: DocKind) {
        create_doc(location: { workspace: { workspace_id: $workspaceId, name: $name, kind: $kind } }) { id }
      }`,
      args,
      { idempotent: false },
    );
    return data.create_doc.id;
  }

  async createDocBlock(args: { docId: string; type: string; content: string; afterBlockId?: string; parentBlockId?: string }): Promise<string> {
    const data = await this.gql.request<{ create_doc_block: { id: string } }>(
      `mutation ($docId: ID!, $type: DocBlockContentType!, $content: JSON!, $after: String, $parent: String) {
        create_doc_block(doc_id: $docId, type: $type, content: $content, after_block_id: $after, parent_block_id: $parent) { id }
      }`,
      { docId: args.docId, type: args.type, content: args.content, after: args.afterBlockId ?? null, parent: args.parentBlockId ?? null },
      { idempotent: false },
    );
    return data.create_doc_block.id;
  }

  async listColumns(boardId: string): Promise<ColumnDef[]> {
    const data = await this.gql.request<{ boards: { columns: { id: string; title: string; type: string; settings_str: string }[] }[] }>(
      `query ($boardId: [ID!]) { boards(ids: $boardId) { columns { id title type settings_str } } }`,
      { boardId: [boardId] },
    );
    return (data.boards[0]?.columns ?? []).map((c) => ({ id: c.id, title: c.title, type: c.type, settingsStr: c.settings_str }));
  }
}

// Makes no API calls: hands out fake ids and records every call, so `--dry-run` walks the exact
// code path a real restore would and reports what it would create. Also the tests' fake Monday.
export class DryRunRestoreApi implements RestoreApi {
  readonly calls: { method: keyof RestoreApi; args: unknown }[] = [];
  private nextId = 1000;
  private readonly subitemBoards = new Map<string, string>(); // parent board → subitems board
  private readonly itemBoards = new Map<string, string>(); // item → board
  private readonly columns = new Map<string, ColumnDef[]>();

  // Tests can make a call fail by returning an Error for it.
  constructor(private readonly failWhen: (method: keyof RestoreApi, args: unknown) => Error | undefined = () => undefined) {}

  private record(method: keyof RestoreApi, args: unknown): void {
    const failure = this.failWhen(method, args);
    this.calls.push({ method, args });
    if (failure !== undefined) throw failure;
  }

  private id(): string {
    return String(this.nextId++);
  }

  async createBoard(args: Parameters<RestoreApi['createBoard']>[0]): Promise<string> {
    this.record('createBoard', args);
    const id = this.id();
    this.columns.set(id, [{ id: 'name', title: 'Name', type: 'name', settingsStr: '{}' }]);
    return id;
  }

  async createColumn(args: Parameters<RestoreApi['createColumn']>[0]): Promise<string> {
    this.record('createColumn', args);
    const id = args.id ?? `col_${this.id()}`;
    this.columns.get(args.boardId)?.push({ id, title: args.title, type: args.type, settingsStr: '{}' });
    return id;
  }

  async createGroup(args: Parameters<RestoreApi['createGroup']>[0]): Promise<string> {
    this.record('createGroup', args);
    return `group_${this.id()}`;
  }

  async createItem(args: Parameters<RestoreApi['createItem']>[0]): Promise<string> {
    this.record('createItem', args);
    const id = this.id();
    this.itemBoards.set(id, args.boardId);
    return id;
  }

  async createSubitem(args: Parameters<RestoreApi['createSubitem']>[0]): Promise<{ id: string; boardId: string }> {
    this.record('createSubitem', args);
    const parentBoard = this.itemBoards.get(args.parentItemId) ?? 'unknown';
    let boardId = this.subitemBoards.get(parentBoard);
    if (boardId === undefined) {
      boardId = this.id();
      this.subitemBoards.set(parentBoard, boardId);
      // Monday auto-creates a subitems board with a name column and a few defaults.
      this.columns.set(boardId, [
        { id: 'name', title: 'Name', type: 'name', settingsStr: '{}' },
        { id: 'person', title: 'Owner', type: 'people', settingsStr: '{}' },
      ]);
    }
    const id = this.id();
    this.itemBoards.set(id, boardId);
    return { id, boardId };
  }

  async setColumnValues(args: Parameters<RestoreApi['setColumnValues']>[0]): Promise<void> {
    this.record('setColumnValues', args);
  }

  async createUpdate(args: Parameters<RestoreApi['createUpdate']>[0]): Promise<string> {
    this.record('createUpdate', args);
    return this.id();
  }

  async archiveBoard(boardId: string): Promise<void> {
    this.record('archiveBoard', boardId);
  }

  async createDoc(args: Parameters<RestoreApi['createDoc']>[0]): Promise<string> {
    this.record('createDoc', args);
    return this.id();
  }

  async createDocBlock(args: Parameters<RestoreApi['createDocBlock']>[0]): Promise<string> {
    this.record('createDocBlock', args);
    return `block_${this.id()}`;
  }

  async listColumns(boardId: string): Promise<ColumnDef[]> {
    this.record('listColumns', boardId);
    return [...(this.columns.get(boardId) ?? [])];
  }

  count(method: keyof RestoreApi): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  argsOf<M extends keyof RestoreApi>(method: M): Parameters<RestoreApi[M]>[0][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args as Parameters<RestoreApi[M]>[0]);
  }
}
