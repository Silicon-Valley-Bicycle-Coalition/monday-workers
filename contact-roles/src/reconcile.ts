// One reconcile run: read the Affiliations board once, then for each enabled opportunity board
// recompute every item's Contacts and write only the ones that differ. Stateless and idempotent,
// so a failed board or run is simply redone by the next cron tick.
//
// Logs carry board names, ids and counts only; never a person's name or email.
import type { BoardRule, ContactRolesConfig } from './config.ts';
import { buildIndex, planBoard } from './contacts';
import type { ContactRolesMondayClient } from './monday/client.ts';
import { MondayApiError } from './monday/graphql';

export interface RunDeps { monday: ContactRolesMondayClient; config: ContactRolesConfig; environment?: string }
export interface BoardSummary {
  name: string;
  skipped?: 'disabled' | 'unknown-role' | 'no-confirmed-roles';
  // `true`: a read error stopped the whole board. A number: how many item writes failed while
  // the rest of the board still ran. Other boards run either way.
  failed?: true | number;
  items: number;
  updates: number;
  written: number;
}
export interface RunSummary { mode: 'on' | 'off'; boards: BoardSummary[] }

/** Every role label a rule can ask for: its fixed role, or all typeRoles values. */
function rolesOf(rule: BoardRule): string[] {
  return rule.role !== undefined ? [rule.role] : Object.values(rule.typeRoles ?? {});
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : 'UnknownError');
// Class name plus, for Monday API errors, status and code. Never the message text.
const errFields = (err: unknown): { error: string; httpStatus?: number; code?: string } => ({
  error: errName(err),
  ...(err instanceof MondayApiError ? { ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}), ...(err.code !== undefined ? { code: err.code } : {}) } : {}),
});

export async function runReconcile(deps: RunDeps, mode: 'on' | 'off'): Promise<RunSummary> {
  const { monday, config } = deps;
  let labels: Set<string>;
  let index: ReturnType<typeof buildIndex>;
  let confirmed: number;
  try {
    labels = new Set(await monday.roleLabels(config.affiliations));
    const affiliations = await monday.listAffiliations(config.affiliations);
    confirmed = affiliations.filter((a) => a.roles.length > 0).length;
    index = buildIndex(affiliations, config.affiliations.currentLabel);
  } catch (err) {
    console.error(JSON.stringify({ worker: 'contact-roles', event: 'run-failed', environment: deps.environment, mode, ...errFields(err) }));
    throw err; // fail the cron invocation
  }

  if (confirmed === 0) {
    // Mass-removal guard: with no confirmed role anywhere (a cleared or renamed column, a read
    // that came back empty) every Contacts column would be blanked. Leave them all as they are.
    console.warn(JSON.stringify({ worker: 'contact-roles', event: 'no-confirmed-roles', affiliations: 0, boards: config.boards.length }));
    const boards = config.boards.map((r): BoardSummary => ({ name: r.name, skipped: 'no-confirmed-roles', items: 0, updates: 0, written: 0 }));
    console.log(JSON.stringify({ worker: 'contact-roles', event: 'run-complete', mode, boards }));
    return { mode, boards };
  }

  const boards: BoardSummary[] = [];
  for (const rule of config.boards) {
    const summary: BoardSummary = { name: rule.name, items: 0, updates: 0, written: 0 };
    boards.push(summary);
    if (!rule.enabled) {
      summary.skipped = 'disabled';
      continue;
    }
    const missing = rolesOf(rule).filter((r) => !labels.has(r));
    if (missing.length > 0) {
      // Leave Contacts untouched: a renamed label must not blank a board.
      summary.skipped = 'unknown-role';
      console.warn(JSON.stringify({ worker: 'contact-roles', event: 'skipped-unknown-role', board: rule.name, boardId: rule.boardId, missingRoles: missing.length }));
      continue;
    }
    try {
      const items = await monday.listBoardItems(rule);
      const updates = planBoard(rule, items, index);
      summary.items = items.length;
      summary.updates = updates.length;
      if (mode === 'on') {
        // One bad item must not starve the rest of the board on every run: count it, log its
        // id once, keep going.
        for (const u of updates) {
          try {
            await monday.setContacts(rule, u.itemId, u.personIds);
            summary.written++;
          } catch (err) {
            summary.failed = (typeof summary.failed === 'number' ? summary.failed : 0) + 1;
            console.error(JSON.stringify({ worker: 'contact-roles', event: 'item-failed', board: rule.name, boardId: rule.boardId, itemId: u.itemId, ...errFields(err) }));
          }
        }
      }
    } catch (err) {
      summary.failed = true;
      console.error(JSON.stringify({ worker: 'contact-roles', event: 'board-failed', board: rule.name, boardId: rule.boardId, ...errFields(err), written: summary.written }));
    }
  }

  console.log(JSON.stringify({ worker: 'contact-roles', event: 'run-complete', mode, boards }));
  return { mode, boards };
}
