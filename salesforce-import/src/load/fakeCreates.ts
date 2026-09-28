// Test support (imported only by *.test.ts): lets a fake Monday answer both create_item shapes
// the loader sends — the sequential single mutation and the aliased batch (load/batch.ts).

export interface CreateCall {
  boardId: string;
  name: string;
  cols: Record<string, unknown>;
  /** Relation column ids the batch asked to read back on this alias. */
  readBack: string[];
}

/** One alias's answer: an item (with the relations it holds), a GraphQL error, or bare null. */
export type CreateReply = { id: string; rel?: Record<string, number[]> } | { error: string } | null;

const isBatch = (query: string): boolean => /i0: create_item/.test(query);

/** The creates in a request, in alias order; null when the request isn't a create. */
export function parseCreates(query: string, v: Record<string, unknown>): CreateCall[] | null {
  if (!/create_item/.test(query)) return null;
  if (!isBatch(query)) {
    return [{ boardId: String(v['boardId']), name: v['itemName'] as string,
      cols: JSON.parse(v['cols'] as string) as Record<string, unknown>, readBack: [] }];
  }
  const out: CreateCall[] = [];
  for (let i = 0; `n${i}` in v; i++) {
    out.push({ boardId: String(v['board']), name: v[`n${i}`] as string,
      cols: JSON.parse(v[`c${i}`] as string) as Record<string, unknown>,
      readBack: (v[`r${i}`] as string[] | undefined) ?? [] });
  }
  return out;
}

/** Board-relation values (`{ item_ids }`) found in a create's column values. */
export function relationsIn(cols: Record<string, unknown>): Record<string, number[]> {
  const rel: Record<string, number[]> = {};
  for (const [k, val] of Object.entries(cols)) {
    if (val && typeof val === 'object' && 'item_ids' in val) rel[k] = (val as { item_ids: number[] }).item_ids;
  }
  return rel;
}

/** Monday's response for `calls`, given each alias's reply. */
export function createResponse(query: string, calls: CreateCall[], replies: CreateReply[]): Response {
  if (!isBatch(query)) {
    const r = replies[0];
    if (r && 'id' in r) return Response.json({ data: { create_item: { id: r.id } } });
    return Response.json({ errors: [{ message: r && 'error' in r ? r.error : 'create failed' }] });
  }
  const data: Record<string, unknown> = {};
  const errors: unknown[] = [];
  replies.forEach((r, i) => {
    if (r && 'id' in r) {
      const read = calls[i]!.readBack;
      data[`i${i}`] = { id: r.id, ...(read.length ? { column_values: read.map((c) =>
        ({ id: c, linked_item_ids: (r.rel?.[c] ?? []).map(String) })) } : {}) };
    } else {
      data[`i${i}`] = null;
      if (r) errors.push({ message: r.error, path: [`i${i}`] });
    }
  });
  return Response.json(errors.length ? { data, errors } : { data });
}
