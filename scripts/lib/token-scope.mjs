// Shared by scripts/check-monday-token-scope.mjs and the monday-auth Worker's probe route.
// Dependency-free and runtime-neutral (no Node builtins), so it bundles into a Worker.

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

// Pure: `boards` is what the boards query returned ({ id, workspace_id, board_kind, permissions,
// state }). `permissions: "everyone"` means any team member — this token's user included — can
// edit. `state` is active, archived or deleted; a board without one counts as active.
export function summarizeScope(boards, allowedWorkspaceIds) {
  const allowed = new Set(allowedWorkspaceIds.map(String));
  const byWorkspace = new Map();
  const byKind = {};
  const byState = {};
  let inside = 0;
  let editableByEveryone = 0;
  for (const board of boards) {
    const workspaceId = board.workspace_id === null || board.workspace_id === undefined ? '(none)' : String(board.workspace_id);
    if (allowed.has(workspaceId)) {
      inside++;
      continue;
    }
    const everyone = board.permissions === 'everyone';
    const state = board.state ?? 'active';
    if (everyone) editableByEveryone++;
    byKind[board.board_kind] = (byKind[board.board_kind] ?? 0) + 1;
    byState[state] = (byState[state] ?? 0) + 1;
    const entry = byWorkspace.get(workspaceId) ?? { workspaceId, boards: 0, editableByEveryone: 0, notActive: 0 };
    entry.boards++;
    if (everyone) entry.editableByEveryone++;
    if (state !== 'active') entry.notActive++;
    byWorkspace.set(workspaceId, entry);
  }
  const workspaces = [...byWorkspace.values()].sort((a, b) => b.boards - a.boards || a.workspaceId.localeCompare(b.workspaceId));
  return {
    total: boards.length,
    inside,
    outside: { boards: boards.length - inside, editableByEveryone, byKind, byState, workspaces },
  };
}

// Pages every board, any state. `queryFn(graphql)` runs one query and returns its `data`
// (throwing on an API error), so each caller supplies its own transport and token header.
export async function listBoards(queryFn) {
  const boards = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await queryFn(`{ boards(limit: ${PAGE_SIZE}, page: ${page}, state: all) { id workspace_id board_kind permissions state } }`);
    boards.push(...data.boards);
    if (data.boards.length < PAGE_SIZE) return boards;
  }
  throw new Error(`more than ${MAX_PAGES * PAGE_SIZE} boards; raise MAX_PAGES`);
}
