#!/usr/bin/env node
// Creates the Letter Settings board the donor-portal Worker's January letter cron reads (see
// src/letters/runLetterCron.ts): a single-item board whose three columns are the staff controls —
// an Auto-send checkbox, an Auto-send start date, and the letter-ready email body template.
// Prints the board/column ids to paste into config/svbc.json's `letterCron` section.
//
// Run once per environment against the right workspace (sandbox first, production at rollout) —
// the same command both times, so the sandbox run doubles as the rehearsal:
//
//   MONDAY_API_TOKEN=... node scripts/create-letter-settings-board.mjs --workspace <workspaceId> \
//     [--name "Donor Portal Letter Settings"]
//
// The token needs board-create permission in the target workspace. Note that's *more* than the
// portal's own least-privilege integration user should hold — run this as an admin/staff user,
// then grant the integration user read access to the created board (it never writes to it).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const token = process.env.MONDAY_API_TOKEN;
if (!token) {
  console.error('create-letter-settings-board: MONDAY_API_TOKEN is required');
  process.exit(1);
}

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const workspaceId = argValue('--workspace');
if (!workspaceId) {
  console.error('create-letter-settings-board: --workspace <workspaceId> is required');
  process.exit(1);
}
const boardName = argValue('--name') ?? 'Donor Portal Letter Settings';

const config = JSON.parse(readFileSync(join(HERE, '..', 'config', 'svbc.json'), 'utf8'));
const { apiUrl } = config.monday;

async function graphql(query, variables) {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2026-01' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`monday API: HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`monday API: ${json.errors.map((e) => e.message).join('; ')}`);
  if (!json.data) throw new Error(`monday API: no data — ${JSON.stringify(json)}`);
  return json.data;
}

// Keep in sync with src/letters/letterEmailBody.ts (placeholders) and the built-in copy in
// src/email/cloudflareEmail.ts, which this template starts out mirroring.
const DEFAULT_TEMPLATE = `Hi {{donorName}},

Your {{year}} giving letter is ready to view in your donor portal.

Log in to view it: {{loginUrl}}

This link expires soon and can only be used once.`;

const ITEM_NAME = 'Letter emails';

// Pre-flight: refuse to create a duplicate. An accidental second run against the same
// workspace would otherwise mint a second settings board and a config-pointing footgun.
const existing = await graphql(
  `query ($workspaceId: ID!) {
    boards(workspace_ids: [$workspaceId], limit: 200) { id name }
  }`,
  { workspaceId }
);
const clash = (existing.boards ?? []).find((b) => b.name === boardName);
if (clash) {
  console.error(
    `create-letter-settings-board: a board named "${boardName}" already exists in workspace ${workspaceId} (board ${clash.id}) — refusing to create a duplicate. Use --name for a genuinely new board.`
  );
  process.exit(1);
}

const boardData = await graphql(
  `mutation ($name: String!, $workspaceId: ID!) {
    create_board(board_name: $name, board_kind: public, workspace_id: $workspaceId) { id }
  }`,
  { name: boardName, workspaceId }
);
const boardId = boardData.create_board.id;
console.error(`created board ${boardId} ("${boardName}") in workspace ${workspaceId}`);

async function createColumn(title, columnType, description) {
  const data = await graphql(
    `mutation ($boardId: ID!, $title: String!, $columnType: ColumnType!, $description: String) {
      create_column(board_id: $boardId, title: $title, column_type: $columnType, description: $description) { id }
    }`,
    { boardId, title, columnType, description }
  );
  console.error(`created ${columnType} column ${data.create_column.id} ("${title}")`);
  return data.create_column.id;
}

const autoSendId = await createColumn(
  'Auto-send',
  'checkbox',
  'Master switch for the automatic January letter emails. While unchecked, the cron never sends.'
);
const startDateId = await createColumn(
  'Auto-send start date',
  'date',
  'The cron only sends on or after this date. It re-arms each January for the newly completed year, so move this date forward (or uncheck Auto-send) to delay a season.'
);
const bodyTemplateId = await createColumn(
  'Email body template',
  'long_text',
  'Plain text with {{donorName}}, {{year}}, {{loginUrl}} placeholders. Used for every letter-ready email (button and cron). Blank = built-in copy. Pasted HTML is shown literally, never rendered.'
);

const itemData = await graphql(
  `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
    create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id }
  }`,
  {
    boardId,
    itemName: ITEM_NAME,
    columnValues: JSON.stringify({
      [bodyTemplateId]: { text: DEFAULT_TEMPLATE },
    }),
  }
);
const settingsItemId = itemData.create_item.id;
console.error(`created settings item "${ITEM_NAME}" — Auto-send unchecked, start date unset, template pre-filled`);

// Monday's board-creation template seeds default items ("Task 1", …) that sort ahead of the
// settings item; the Worker prefers "${ITEM_NAME}" by name, but leaving stubs on a settings
// board invites staff confusion — delete everything that isn't the item just created.
const listData = await graphql(
  `query ($boardId: [ID!]) {
    boards(ids: $boardId) { items_page(limit: 100) { items { id name } } }
  }`,
  { boardId: [boardId] }
);
for (const item of listData.boards[0]?.items_page.items ?? []) {
  if (item.id === settingsItemId) continue;
  await graphql(`mutation ($itemId: ID!) { delete_item(item_id: $itemId) { id } }`, { itemId: item.id });
  console.error(`deleted board-template default item ${item.id} ("${item.name}")`);
}

console.log(
  JSON.stringify(
    {
      letterCron: {
        boardId: Number(boardId),
        columns: { autoSend: autoSendId, startDate: startDateId, bodyTemplate: bodyTemplateId },
        maxTriggersPerRun: config.letterCron?.maxTriggersPerRun ?? 200,
      },
    },
    null,
    2
  )
);
console.error('\nPaste the letterCron block above into config/svbc.json, then grant the portal integration user read access to the new board.');
