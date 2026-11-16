// The consent sync's pure core (spec docs/superpowers/specs/2026-11-16-mailchimp-consent-columns-
// design.md): Mailchimp's status for an address → the label its Monday consent column should hold,
// the differences to write, and the cap on changes toward a sendable value.
//
// Relative imports here stay `import type` only: scripts/consent-plan.mjs loads this file through
// Node's type stripping, which can't resolve extensionless value imports.
import type { ConsentBoard } from '../types';

export type ConsentLabel = 'Subscribed' | 'Unsubscribed' | 'Cleaned' | 'Not in Mailchimp';

// One Monday item's address and consent columns: column id → text, '' when blank.
export interface ConsentItem { itemId: string; values: Record<string, string> }

export interface ConsentChange {
  boardId: number;
  boardName: string;
  itemId: string;
  consentColumn: string;
  from: string;
  // '' clears the column (the item's address is blank).
  to: ConsentLabel | '';
}

export interface ConsentWrite { boardId: number; itemId: string; columnValues: Record<string, ConsentLabel | ''> }

export function normalizeAddress(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * The label for an address whose Mailchimp status is `status` (undefined: not in the audience).
 * Archived hides a contact's earlier status, and Mailchimp won't email it, so it reads as an
 * opt-out: Cleaned when the column already says so, otherwise Unsubscribed. Never sendable.
 */
export function desiredLabel(status: string | undefined, current: string): ConsentLabel {
  switch (status) {
    case 'subscribed': return 'Subscribed';
    case 'unsubscribed': return 'Unsubscribed';
    case 'cleaned': return 'Cleaned';
    case 'archived': return current === 'Cleaned' ? 'Cleaned' : 'Unsubscribed';
    // pending (double opt-in unconfirmed), transactional, or absent: no consent, no opt-out.
    default: return 'Not in Mailchimp';
  }
}

export function planBoard(board: ConsentBoard, items: readonly ConsentItem[], statuses: ReadonlyMap<string, string>): ConsentChange[] {
  const changes: ConsentChange[] = [];
  for (const item of items) {
    for (const { emailColumn, consentColumn } of board.pairs) {
      const address = normalizeAddress(item.values[emailColumn] ?? '');
      const from = item.values[consentColumn] ?? '';
      const to = address === '' ? '' : desiredLabel(statuses.get(address), from);
      if (to !== from) changes.push({ boardId: board.boardId, boardName: board.name, itemId: item.itemId, consentColumn, from, to });
    }
  }
  return changes;
}

// A value under which the sponsor send (or anyone reading the column) may email the address.
export function isSendable(to: ConsentLabel | ''): boolean {
  return to === 'Subscribed' || to === 'Not in Mailchimp' || to === '';
}

/**
 * Changes to Unsubscribed or Cleaned can only stop mail, so they are always allowed. Changes toward
 * a sendable value are capped: over `max`, every one of them is held for an operator to check.
 */
export function applyGuard(changes: readonly ConsentChange[], max: number): { allowed: ConsentChange[]; held: ConsentChange[]; tripped: boolean } {
  const sendable = changes.filter((c) => isSendable(c.to));
  if (sendable.length <= max) return { allowed: [...changes], held: [], tripped: false };
  return { allowed: changes.filter((c) => !isSendable(c.to)), held: sendable, tripped: true };
}

export function toWrites(changes: readonly ConsentChange[]): ConsentWrite[] {
  const byItem = new Map<string, ConsentWrite>();
  for (const c of changes) {
    const key = `${c.boardId}:${c.itemId}`;
    let write = byItem.get(key);
    if (write === undefined) {
      write = { boardId: c.boardId, itemId: c.itemId, columnValues: {} };
      byItem.set(key, write);
    }
    write.columnValues[c.consentColumn] = c.to;
  }
  return [...byItem.values()];
}

// Counts by board, column and transition. Ids and labels only, never an address.
export function summarize(changes: readonly ConsentChange[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of changes) {
    const key = `${c.boardName} ${c.consentColumn}: ${c.from || '(blank)'} → ${c.to || '(blank)'}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
