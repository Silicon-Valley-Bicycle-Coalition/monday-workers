import type { SourceBoard } from '../config';
import type { Contact } from '../geometry';
import type { ContactKind } from '../types';
import { MONDAY_API_VERSION, MondayGraphQL, type MondayGraphQLOptions, type TokenProvider } from './graphql';

export interface SourcedContact extends Contact { kind: ContactKind }
export interface ResultColumns { connectColumnId: string; labelColumnId: string }

export const CONNECT_TITLE = 'Nearby contact';
export const LABEL_TITLE = 'Nearby search';

// What the preview/confirm API and the queue consumer need from Monday; tests fake this surface.
export interface NearbyMondayClient {
  listContacts(src: SourceBoard): Promise<SourcedContact[]>;
  // Main boards in the given workspaces (no subitem boards or docs).
  listBoards(workspaceIds: number[]): Promise<{ id: string; name: string }[]>;
  getEventAddress(eventsBoardId: number, itemId: string, column: string): Promise<{ name: string; address: string } | null>;
  linkedContactIds(boardId: number, connectColumnId: string): Promise<Set<string>>;
  // Read-only: confirm uses it, so a confirm never writes to Monday.
  findResultColumns(boardId: number): Promise<ResultColumns | null>;
  // Consumer only: creates whichever of the two columns is missing.
  ensureResultColumns(boardId: number, sourceBoardIds: number[]): Promise<ResultColumns>;
  createResultRow(boardId: number, name: string, cols: ResultColumns, contactId: string, label: string): Promise<string>;
  addNearbyLabel(itemId: string, boardId: number, columnId: string, label: string): Promise<void>;
  // Geocode cron: items with a street but no latitude, address = street, city, state, zip joined.
  listMissingCoordinates(src: SourceBoard, limit: number): Promise<{ id: string; address: string }[]>;
  setCoordinates(src: SourceBoard, itemId: string, lat: number, lng: number): Promise<void>;
}

// A queue consumer's retry backoff handles long outages; in-process attempts only ride out blips.
const DEFAULT_OPTIONS: MondayGraphQLOptions = { maxAttempts: 3, requestTimeoutMs: 30_000 };
const PAGE = 500;

interface RawContact { id: string; name: string; column_values: { id: string; text: string | null }[] }

function coordinate(text: string | null | undefined): number | null {
  if (text === null || text === undefined || text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function toContact(raw: RawContact, src: SourceBoard): SourcedContact {
  const text = new Map(raw.column_values.map((cv) => [cv.id, cv.text]));
  let lat = coordinate(text.get(src.latColumn));
  let lng = coordinate(text.get(src.lngColumn));
  // 0/0 is the unset placeholder (Null Island), not a place.
  if (lat === null || lng === null || (lat === 0 && lng === 0)) { lat = null; lng = null; }
  const named = src.nameColumn === null ? null : text.get(src.nameColumn)?.trim();
  return { id: raw.id, name: named ? named : raw.name, lat, lng, zip: null, kind: src.kind };
}

// A search walks every contact on three boards, so each board's {id, name, lat, lng} list is kept
// for a few minutes in two tiers: module scope (the client is rebuilt per request) for the same
// isolate, and, when the caller passes one, the colo's Cache API, because a preview and its confirm
// or a radius change often land on different isolates. A snapshot carries its walk time, and a
// memory entry filled from one expires with it, so neither tier serves anything past the TTL.
// In-flight walks are shared, and a failed walk is evicted so the next search retries. The Cache
// API is best-effort: a failed read or write is a miss, never a failed search. Staleness is
// bounded by the TTL; the geocode cron's new coordinates simply show up within it.
export const CONTACT_CACHE_TTL_MS = 5 * 60_000;
const contactCache = new Map<string, { at: number; contacts: Promise<SourcedContact[]> }>();
export function clearContactCache(): void { contactCache.clear(); }

// Never routed: the Cache API keys on a URL, and this one only names the snapshot. Bump `v1` if
// SourcedContact's shape changes.
const SNAPSHOT_URL = 'https://nearby-search.cache.invalid/contacts/v1';
interface Snapshot { at: number; contacts: SourcedContact[] }

interface Page<T> { cursor: string | null; items: T[] }

export class HttpNearbyMondayClient implements NearbyMondayClient {
  private readonly transport: MondayGraphQL;
  private readonly snapshots: Cache | undefined;

  // `snapshots` (the Workers Cache API, caches.default) shares contact lists across isolates; only
  // the search routes pass it, as nothing else calls listContacts.
  constructor(apiUrl: string, apiToken: string | TokenProvider, options: MondayGraphQLOptions = {}, snapshots?: Cache) {
    this.snapshots = snapshots;
    this.transport = new MondayGraphQL(apiUrl, apiToken, { ...DEFAULT_OPTIONS, ...options, apiVersion: MONDAY_API_VERSION });
  }

  // Every item on a board, following the items_page cursor; `fields` is the per-item selection.
  private async allItems<T>(boardId: number, fields: string, variables: Record<string, unknown>, decl: string): Promise<T[]> {
    const first = await this.transport.request<{ boards: { items_page: Page<T> }[] }>(
      `query ($boardId: [ID!], ${decl}) { boards(ids: $boardId) { items_page(limit: ${PAGE}) { cursor items { ${fields} } } } }`,
      { boardId: [String(boardId)], ...variables },
    );
    let page: Page<T> | undefined = first.boards[0]?.items_page;
    const out: T[] = [];
    while (page) {
      out.push(...page.items);
      if (!page.cursor) break;
      const next: { next_items_page: Page<T> } = await this.transport.request(
        `query ($cursor: String!, ${decl}) { next_items_page(limit: ${PAGE}, cursor: $cursor) { cursor items { ${fields} } } }`,
        { cursor: page.cursor, ...variables },
      );
      page = next.next_items_page;
    }
    return out;
  }

  listContacts(src: SourceBoard): Promise<SourcedContact[]> {
    const key = JSON.stringify([src.boardId, src.kind, src.latColumn, src.lngColumn, src.nameColumn]);
    const hit = contactCache.get(key);
    if (hit && Date.now() - hit.at < CONTACT_CACHE_TTL_MS) return hit.contacts;
    const entry = { at: Date.now(), contacts: Promise.resolve<SourcedContact[]>([]) };
    entry.contacts = this.snapshotOrWalk(src, key, (at) => { entry.at = at; });
    contactCache.set(key, entry);
    entry.contacts.catch(() => { if (contactCache.get(key) === entry) contactCache.delete(key); });
    return entry.contacts;
  }

  // A fresh Cache API snapshot (its walk time reported through `stamp`), else a walk that is then
  // stored for the next isolate.
  private async snapshotOrWalk(src: SourceBoard, key: string, stamp: (at: number) => void): Promise<SourcedContact[]> {
    const url = `${SNAPSHOT_URL}?key=${encodeURIComponent(key)}`;
    if (this.snapshots) {
      try {
        const res = await this.snapshots.match(url);
        if (res) {
          const snap = (await res.json()) as Snapshot;
          if (Date.now() - snap.at < CONTACT_CACHE_TTL_MS) {
            stamp(snap.at);
            return snap.contacts;
          }
        }
      } catch (err) {
        console.error('nearby-search contact snapshot read failed', err instanceof Error ? err.name : 'unknown');
      }
    }
    const at = Date.now();
    const contacts = await this.walkContacts(src);
    if (this.snapshots) {
      const body: Snapshot = { at, contacts };
      const res = new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CONTACT_CACHE_TTL_MS / 1000}` },
      });
      await this.snapshots.put(url, res).catch((err: unknown) => {
        console.error('nearby-search contact snapshot write failed', err instanceof Error ? err.name : 'unknown');
      });
    }
    return contacts;
  }

  private async walkContacts(src: SourceBoard): Promise<SourcedContact[]> {
    const columnIds = [src.latColumn, src.lngColumn, ...(src.nameColumn === null ? [] : [src.nameColumn])];
    const items = await this.allItems<RawContact>(src.boardId, 'id name column_values(ids: $columnIds) { id text }', { columnIds }, '$columnIds: [String!]');
    return items.map((raw) => toContact(raw, src));
  }

  // Main boards only: Monday also lists a board's subitems board, docs and custom objects here,
  // none of which can hold result rows.
  async listBoards(workspaceIds: number[]): Promise<{ id: string; name: string }[]> {
    const data = await this.transport.request<{ boards: { id: string; name: string; type: string | null }[] }>(
      `query ($workspaceIds: [ID!]) { boards(workspace_ids: $workspaceIds, state: active, limit: 500) { id name type } }`,
      { workspaceIds: workspaceIds.map(String) },
    );
    return data.boards
      .filter((b) => b.type === 'board')
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getEventAddress(eventsBoardId: number, itemId: string, column: string): Promise<{ name: string; address: string } | null> {
    const data = await this.transport.request<{ items: { name: string; board: { id: string }; column_values: { text: string | null }[] }[] }>(
      `query ($ids: [ID!], $col: [String!]) { items(ids: $ids) { name board { id } column_values(ids: $col) { text } } }`,
      { ids: [itemId], col: [column] },
    );
    const item = data.items[0];
    if (!item || item.board.id !== String(eventsBoardId)) return null;
    const address = item.column_values[0]?.text?.trim();
    return address ? { name: item.name, address } : null;
  }

  async linkedContactIds(boardId: number, connectColumnId: string): Promise<Set<string>> {
    const items = await this.allItems<{ column_values: { linked_item_ids?: string[] }[] }>(
      boardId, 'column_values(ids: $col) { ... on BoardRelationValue { linked_item_ids } }', { col: [connectColumnId] }, '$col: [String!]',
    );
    return new Set(items.flatMap((i) => i.column_values.flatMap((cv) => cv.linked_item_ids ?? [])));
  }

  private async columns(boardId: number): Promise<{ id: string; title: string; type: string }[]> {
    const data = await this.transport.request<{ boards: { columns: { id: string; title: string; type: string }[] }[] }>(
      `query ($boardId: [ID!]) { boards(ids: $boardId) { columns { id title type } } }`,
      { boardId: [String(boardId)] },
    );
    return data.boards[0]?.columns ?? [];
  }

  async findResultColumns(boardId: number): Promise<ResultColumns | null> {
    const cols = await this.columns(boardId);
    const connect = cols.find((c) => c.title === CONNECT_TITLE && c.type === 'board_relation');
    const label = cols.find((c) => c.title === LABEL_TITLE && c.type === 'text');
    return connect && label ? { connectColumnId: connect.id, labelColumnId: label.id } : null;
  }

  async ensureResultColumns(boardId: number, sourceBoardIds: number[]): Promise<ResultColumns> {
    const cols = await this.columns(boardId);
    const create = async (title: string, type: string, defaults?: string): Promise<string> => {
      const data = await this.transport.request<{ create_column: { id: string } }>(
        `mutation ($boardId: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
          create_column(board_id: $boardId, title: $title, column_type: $type, defaults: $defaults) { id }
        }`,
        { boardId: String(boardId), title, type, defaults },
        { idempotent: false },
      );
      return data.create_column.id;
    };
    const connectColumnId = cols.find((c) => c.title === CONNECT_TITLE && c.type === 'board_relation')?.id
      ?? await create(CONNECT_TITLE, 'board_relation', JSON.stringify({ boardIds: sourceBoardIds }));
    const labelColumnId = cols.find((c) => c.title === LABEL_TITLE && c.type === 'text')?.id
      ?? await create(LABEL_TITLE, 'text');
    return { connectColumnId, labelColumnId };
  }

  async createResultRow(boardId: number, name: string, cols: ResultColumns, contactId: string, label: string): Promise<string> {
    const values = { [cols.connectColumnId]: { item_ids: [Number(contactId)] }, [cols.labelColumnId]: label };
    const data = await this.transport.request<{ create_item: { id: string } }>(
      `mutation ($boardId: ID!, $name: String!, $values: JSON!) {
        create_item(board_id: $boardId, item_name: $name, column_values: $values) { id }
      }`,
      { boardId: String(boardId), name, values: JSON.stringify(values) },
      { idempotent: false },
    );
    return data.create_item.id;
  }

  async addNearbyLabel(itemId: string, boardId: number, columnId: string, label: string): Promise<void> {
    const data = await this.transport.request<{ items: { column_values: { text: string | null }[] }[] }>(
      `query ($ids: [ID!], $col: [String!]) { items(ids: $ids) { column_values(ids: $col) { text } } }`,
      { ids: [itemId], col: [columnId] },
    );
    const text = data.items[0]?.column_values[0]?.text ?? '';
    const existing = text === '' ? [] : text.split(', ');
    if (existing.includes(label)) return;
    // Re-setting the same label list is idempotent, so the default retry policy applies.
    await this.transport.request(
      `mutation ($boardId: ID!, $itemId: ID!, $col: String!, $value: JSON!) {
        change_column_value(board_id: $boardId, item_id: $itemId, column_id: $col, value: $value, create_labels_if_missing: true) { id }
      }`,
      { boardId: String(boardId), itemId, col: columnId, value: JSON.stringify({ labels: [...existing, label] }) },
    );
  }

  async listMissingCoordinates(src: SourceBoard, limit: number): Promise<{ id: string; address: string }[]> {
    if (src.address === null) return [];
    const a = src.address;
    const columnIds = [a.street, a.city, a.state, a.zip];
    const fields = 'id column_values(ids: $columnIds) { id text }';
    const queryParams = {
      operator: 'and',
      rules: [
        { column_id: src.latColumn, compare_value: [], operator: 'is_empty' },
        { column_id: a.street, compare_value: [], operator: 'is_not_empty' },
      ],
    };
    const toAddress = (raw: RawContact) => {
      const text = new Map(raw.column_values.map((cv) => [cv.id, cv.text?.trim() ?? '']));
      return { id: raw.id, address: columnIds.map((c) => text.get(c) ?? '').filter((t) => t !== '').join(', ') };
    };
    const out: { id: string; address: string }[] = [];
    const first = await this.transport.request<{ boards: { items_page: Page<RawContact> }[] }>(
      `query ($boardId: [ID!], $columnIds: [String!], $qp: ItemsQuery) { boards(ids: $boardId) { items_page(limit: ${Math.min(limit, PAGE)}, query_params: $qp) { cursor items { ${fields} } } } }`,
      { boardId: [String(src.boardId)], columnIds, qp: queryParams },
    );
    let page: Page<RawContact> | undefined = first.boards[0]?.items_page;
    while (page) {
      out.push(...page.items.map(toAddress));
      if (out.length >= limit || !page.cursor) break;
      const next: { next_items_page: Page<RawContact> } = await this.transport.request(
        `query ($cursor: String!, $columnIds: [String!]) { next_items_page(limit: ${Math.min(limit - out.length, PAGE)}, cursor: $cursor) { cursor items { ${fields} } } }`,
        { cursor: page.cursor, columnIds },
      );
      page = next.next_items_page;
    }
    return out.slice(0, limit);
  }

  async setCoordinates(src: SourceBoard, itemId: string, lat: number, lng: number): Promise<void> {
    // Both columns in one request; re-setting the same values is idempotent, so retries are safe.
    await this.transport.request(
      `mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id }
      }`,
      { boardId: String(src.boardId), itemId, values: JSON.stringify({ [src.latColumn]: lat.toFixed(6), [src.lngColumn]: lng.toFixed(6) }) },
    );
  }
}
