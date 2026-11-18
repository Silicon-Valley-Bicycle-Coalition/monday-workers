import type { ItemPayload } from '../transform/types.js';

/** A board-relation value written inside `create_item` instead of by the separate link pass. */
export interface InlineLink {
  column: string;
  colId: string;
  targetSfIds: string[];
  targetItemIds: number[];
}

export interface InlineContext {
  /** The target's Monday item id, if it has been created (ledgered). */
  itemIdOf(sfId: string): string | undefined;
  /** Whether this run's payloads are expected to create that Salesforce Id. */
  isExpected(sfId: string): boolean;
  /** Whether the target has been archived (archived items reject writes). */
  isArchived(sfId: string): boolean;
  /** The source board's column id for a connect column title. */
  columnId(title: string): string | undefined;
}

/**
 * Which of a payload's links can be set in its own `create_item` (GL#22): exactly the ones the
 * link pass would write in full right now. A link is left to the link pass — which owns the
 * pending/partial/skipped accounting and the archive gate (GL#21) — whenever any target this run
 * still has to create is missing, no target resolves, a target is archived, or the column is
 * unknown. Targets that were never migrated are dropped, as the link pass drops them.
 */
export function planInlineLinks(p: ItemPayload, ctx: InlineContext): InlineLink[] {
  const out: InlineLink[] = [];
  for (const link of p.links ?? []) {
    const resolved = link.targetSfIds
      .map((sfId) => ({ sfId, itemId: ctx.itemIdOf(sfId) }))
      .filter((t): t is { sfId: string; itemId: string } => t.itemId !== undefined);
    const pending = link.targetSfIds.some((t) => ctx.itemIdOf(t) === undefined && ctx.isExpected(t));
    if (pending || resolved.length === 0) continue;
    if (resolved.some((t) => ctx.isArchived(t.sfId))) continue;
    const colId = ctx.columnId(link.column);
    if (!colId) continue;
    out.push({ column: link.column, colId, targetSfIds: resolved.map((t) => t.sfId),
      targetItemIds: resolved.map((t) => Number(t.itemId)) });
  }
  return out;
}
