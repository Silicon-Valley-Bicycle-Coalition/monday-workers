import type { ItemPayload } from '../transform/types.js';
import type { MondayClient } from './monday.js';
import { COLUMN_TYPES } from './boards.js';

/**
 * Transform can't know Monday user ids (the staff export has none), so a people column arrives as
 * the staff member's email. One `users(emails:)` lookup turns each into Monday's people value;
 * an email with no Monday user is cleared and reported, never guessed. Mutates `payloads`.
 */
export async function resolvePeopleColumns(
  payloads: ItemPayload[], client: Pick<MondayClient, 'gql'>,
): Promise<{ resolved: number; unmatched: string[] }> {
  const peopleCols = Object.keys(COLUMN_TYPES).filter((t) => COLUMN_TYPES[t] === 'people');
  const emails = new Set<string>();
  for (const p of payloads) {
    for (const col of peopleCols) {
      const v = p.columns[col];
      if (typeof v === 'string' && v) emails.add(v.toLowerCase());
    }
  }
  if (emails.size === 0) return { resolved: 0, unmatched: [] };
  const data = await client.gql<{ users: { id: string; email: string }[] }>(
    'query ($emails: [String]) { users(emails: $emails, limit: 100) { id email } }', { emails: [...emails] });
  const idOf = new Map(data.users.map((u) => [u.email.toLowerCase(), Number(u.id)]));
  let resolved = 0;
  for (const p of payloads) {
    for (const col of peopleCols) {
      const v = p.columns[col];
      if (typeof v !== 'string' || !v) continue;
      const id = idOf.get(v.toLowerCase());
      p.columns[col] = id ? { personsAndTeams: [{ id, kind: 'person' }] } : '';
      if (id) resolved++;
    }
  }
  return { resolved, unmatched: [...emails].filter((e) => !idOf.has(e)).sort() };
}
