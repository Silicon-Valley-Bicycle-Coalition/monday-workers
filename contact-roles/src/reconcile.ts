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
  skipped?: 'disabled' | 'unknown-role';
  failed?: boolean; // a Monday error stopped this board; the others still ran
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
  try {
    labels = new Set(await monday.roleLabels(config.affiliations));
    index = buildIndex(await monday.listAffiliations(config.affiliations), config.affiliations.currentLabel);
  } catch (err) {
    console.error(JSON.stringify({ worker: 'contact-roles', event: 'run-failed', environment: deps.environment, mode, ...errFields(err) }));
    throw err; // fail the cron invocation
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
    let itemId: string | undefined;
    try {
      const items = await monday.listBoardItems(rule);
      const updates = planBoard(rule, items, index);
      summary.items = items.length;
      summary.updates = updates.length;
      if (mode === 'on') {
        for (const u of updates) {
          itemId = u.itemId;
          await monday.setContacts(rule, u.itemId, u.personIds);
          summary.written++;
        }
      }
    } catch (err) {
      summary.failed = true;
      console.error(JSON.stringify({ worker: 'contact-roles', event: 'board-failed', board: rule.name, boardId: rule.boardId, ...errFields(err), ...(itemId !== undefined ? { itemId } : {}), written: summary.written }));
    }
  }

  console.log(JSON.stringify({ worker: 'contact-roles', event: 'run-complete', mode, boards }));
  return { mode, boards };
}
