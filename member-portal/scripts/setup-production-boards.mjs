#!/usr/bin/env node
// Scripts DEPLOY.md's "Phase 1 — Monday: boards, columns" (GitLab svbc-monday-migration#18): the
// two Organizations columns the discount section needs, and the Change Requests board staff
// process edits from. Does NOT create the integration user (DEPLOY.md Phase 1 step 3) — minting a
// user/token is an admin-console action, not an API mutation worth automating.
//
// Run once per environment against the right workspace/board (sandbox first, production at
// rollout) — the same command both times, so the sandbox run doubles as the rehearsal:
//
//   MONDAY_API_TOKEN=... node scripts/setup-production-boards.mjs \
//     --org-board-id <organizationsBoardId> --donors-board-id <donorsBoardId> \
//     --workspace <workspaceId> [--name "Change Requests"]
//
// Idempotent: re-running skips an Organizations column whose title already exists, and refuses
// to create a second same-named Change Requests board in the workspace (use --name to make a
// genuinely new one). The token needs board-create permission in the target workspace — run this
// as an admin/staff user, then grant the portal's least-privilege integration user item-create
// rights on the new board and viewer rights on the Organizations columns, per DEPLOY.md step 3.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MondayGraphQL } from '../src/monday/graphql.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const token = process.env.MONDAY_API_TOKEN;
if (!token) {
  console.error('setup-production-boards: MONDAY_API_TOKEN is required');
  process.exit(1);
}

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const orgBoardId = argValue('--org-board-id');
const donorsBoardId = argValue('--donors-board-id');
const workspaceId = argValue('--workspace');
if (!orgBoardId || !donorsBoardId || !workspaceId) {
  console.error(
    'setup-production-boards: --org-board-id, --donors-board-id, and --workspace are all required'
  );
  process.exit(1);
}
const boardName = argValue('--name') ?? 'Change Requests';

const config = JSON.parse(readFileSync(join(HERE, '..', 'config', 'svbc.json'), 'utf8'));
const { apiUrl } = config.monday;

// The Worker's own copy of the canonical Monday transport (#35): retries rate limits and Monday
// blips, times out hung requests, and never blindly re-runs a create. Imported as TypeScript —
// needs a Node with built-in type stripping (22.18+ / 23.6+).
const monday = new MondayGraphQL(apiUrl, token);

// Mutations here create boards, columns and webhooks, so a failure that may have committed throws
// AmbiguousWriteError instead of being retried into a duplicate; queries get the full retry.
async function graphql(query, variables) {
  return monday.request(query, variables, { idempotent: !/^\s*mutation\b/.test(query) });
}

async function createColumnOn(boardId, title, columnType, description, columnSettings) {
  const data = await graphql(
    `mutation ($boardId: ID!, $title: String!, $columnType: ColumnType!, $description: String, $defaults: JSON) {
      create_column(board_id: $boardId, title: $title, column_type: $columnType, description: $description, defaults: $defaults) { id }
    }`,
    { boardId, title, columnType, description, defaults: columnSettings ? JSON.stringify(columnSettings) : undefined }
  );
  console.error(`created ${columnType} column ${data.create_column.id} ("${title}") on board ${boardId}`);
  return data.create_column.id;
}

// Adds a column only if no column of that title already exists on the board. Returns its id
// either way, so a re-run is safe and always yields a complete id map.
async function ensureColumnOn(boardId, title, columnType, description, columnSettings) {
  const boardData = await graphql(
    `query ($boardId: [ID!]) { boards(ids: $boardId) { columns { id title } } }`,
    { boardId: [boardId] }
  );
  const existing = (boardData.boards[0]?.columns ?? []).find((c) => c.title === title);
  if (existing) {
    console.error(`column "${title}" already exists (${existing.id}) on board ${boardId} — skipping`);
    return existing.id;
  }
  return createColumnOn(boardId, title, columnType, description, columnSettings);
}

// ---- Organizations: Discount Offered / Discount Active (DEPLOY.md Phase 1 step 1) ----
const discountOfferedId = await ensureColumnOn(
  orgBoardId,
  'Discount Offered',
  'text',
  'What discount this partner offers members (e.g. "10% off parts and labor"). Free text, staff-maintained — powers the member portal’s discount section.'
);
const discountActiveId = await ensureColumnOn(
  orgBoardId,
  'Discount Active',
  'checkbox',
  'Whether the discount above is currently honored. Unchecked orgs are hidden from the portal even if Discount Offered has text.'
);

// ---- Change Requests board (DEPLOY.md Phase 1 step 2) ----
const existing = await graphql(
  `query ($workspaceId: ID!) { boards(workspace_ids: [$workspaceId], limit: 200) { id name } }`,
  { workspaceId }
);
const clash = (existing.boards ?? []).find((b) => b.name === boardName);
if (clash) {
  console.error(
    `setup-production-boards: a board named "${boardName}" already exists in workspace ${workspaceId} (board ${clash.id}) — refusing to create a duplicate. Use --name for a genuinely new board.`
  );
  process.exit(1);
}

// Private, not the account default "everyone" — this board holds real pending edits to donor
// records (DEPLOY.md: "Restrict board access to staff who process changes"). Subscribing the
// actual staff who process changes is a manual follow-up; this script only sets the board kind.
const boardData = await graphql(
  `mutation ($name: String!, $workspaceId: ID!) {
    create_board(board_name: $name, board_kind: private, workspace_id: $workspaceId) { id }
  }`,
  { name: boardName, workspaceId }
);
const changeRequestsBoardId = boardData.create_board.id;
console.error(`created private board ${changeRequestsBoardId} ("${boardName}") in workspace ${workspaceId}`);

const donorLinkId = await createColumnOn(
  changeRequestsBoardId,
  'Donor',
  'board_relation',
  'The donor who submitted this change request.',
  { boardIds: [Number(donorsBoardId)], boardId: Number(donorsBoardId), allowCreateReflectionColumn: true }
);
const fieldId = await createColumnOn(changeRequestsBoardId, 'Field', 'text', 'Which field the donor wants changed (e.g. "Mailing address").');
const oldValueId = await createColumnOn(changeRequestsBoardId, 'Old Value', 'text', 'The value on file when the request was submitted.');
const newValueId = await createColumnOn(changeRequestsBoardId, 'New Value', 'text', 'The value the donor is requesting.');
const submittedAtId = await createColumnOn(changeRequestsBoardId, 'Submitted At', 'date', 'When the donor submitted this request, for the dedupe window and retention.');

// Monday's board-creation template seeds default items ("Task 1", …); delete them so the board
// starts genuinely empty rather than inviting staff confusion.
const listData = await graphql(
  `query ($boardId: [ID!]) { boards(ids: $boardId) { items_page(limit: 100) { items { id name } } } }`,
  { boardId: [changeRequestsBoardId] }
);
for (const item of listData.boards[0]?.items_page.items ?? []) {
  await graphql(`mutation ($itemId: ID!) { delete_item(item_id: $itemId) { id } }`, { itemId: item.id });
  console.error(`deleted board-template default item ${item.id} ("${item.name}")`);
}

console.log(
  JSON.stringify(
    {
      monday: { columns: { discountOffered: discountOfferedId, discountActive: discountActiveId } },
      changeRequests: {
        boardId: Number(changeRequestsBoardId),
        columns: { donorLink: donorLinkId, field: fieldId, oldValue: oldValueId, newValue: newValueId, submittedAt: submittedAtId },
      },
    },
    null,
    2
  )
);
console.error(
  '\nMerge the block above into config/svbc.json (monday.columns.discountOffered/discountActive, ' +
  'changeRequests.boardId + changeRequests.columns). Then: tag partner orgs’ Discount Offered/Active ' +
  'values, subscribe the staff who process changes to the new private Change Requests board, and ' +
  'grant the portal integration user item-create rights on it plus viewer rights on the two new ' +
  'Organizations columns (DEPLOY.md Phase 1 step 3).'
);
