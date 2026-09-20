#!/usr/bin/env node
// Creates the Letter Settings board the member-portal Worker's January letter cron reads (see
// src/letters/runLetterCron.ts): a single-item board whose three columns are the staff controls —
// an Auto-send checkbox, an Auto-send start date, and the letter-ready email body template.
// Prints the board/column ids to paste into config/svbc.json's `letterCron` section.
//
// Run once per environment against the right workspace (sandbox first, production at rollout) —
// the same command both times, so the sandbox run doubles as the rehearsal:
//
//   MONDAY_API_TOKEN=... node scripts/create-letter-settings-board.mjs --workspace <workspaceId> \
//     [--name "Member Portal Letter Settings"]
//
// A fresh board gets one "Email body template" column per non-English locale in addition to the
// default one. To add those locale columns to a board created before they existed, run the
// upgrade mode instead (idempotent — skips columns whose title already exists):
//
//   MONDAY_API_TOKEN=... node scripts/create-letter-settings-board.mjs --add-locale-columns <boardId>
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

const upgradeBoardId = argValue('--add-locale-columns');
const workspaceId = argValue('--workspace');
if (!workspaceId && !upgradeBoardId) {
  console.error('create-letter-settings-board: --workspace <workspaceId> (create) or --add-locale-columns <boardId> (upgrade) is required');
  process.exit(1);
}
const boardName = argValue('--name') ?? 'Member Portal Letter Settings';

const config = JSON.parse(readFileSync(join(HERE, '..', 'config', 'svbc.json'), 'utf8'));
const { apiUrl } = config.monday;

// Keep in sync with LOCALE_LABELS in src/i18n/locales.ts — 'en' is deliberately absent: English
// donors use the default "Email body template" column, like any locale without its own column.
const NON_EN_LOCALES = {
  es: 'Spanish',
  'zh-Hans': 'Chinese (Simplified)',
  'zh-Hant': 'Chinese (Traditional)',
  fil: 'Filipino',
  hi: 'Hindi',
  ja: 'Japanese',
  ko: 'Korean',
  'pt-BR': 'Portuguese (Brazil)',
  vi: 'Vietnamese',
};

const localeColumnTitle = (label) => `Email body template (${label})`;
const localeColumnDescription = (label) =>
  `Optional ${label} version of the letter-ready email. Same {{donorName}}/{{year}}/{{loginUrl}} placeholders as the main template. Blank = donors with this language preference get the main template (or the built-in copy in their language if that is blank too).`;

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

Your {{year}} giving letter is ready to view in your member portal.

Log in to view it: {{loginUrl}}

This link expires soon and can only be used once.`;

// Same config key the Worker's getLetterSettings matches on (src/config.ts defaults it to
// 'Letter emails' when absent) — keeping the two in sync is what lets the cron find the item
// this script creates.
const ITEM_NAME = config.letterCron?.settingsItemName ?? 'Letter emails';

async function createColumnOn(boardId, title, columnType, description) {
  const data = await graphql(
    `mutation ($boardId: ID!, $title: String!, $columnType: ColumnType!, $description: String) {
      create_column(board_id: $boardId, title: $title, column_type: $columnType, description: $description) { id }
    }`,
    { boardId, title, columnType, description }
  );
  console.error(`created ${columnType} column ${data.create_column.id} ("${title}")`);
  return data.create_column.id;
}

// Creates any missing per-locale template columns on the board, keyed by column title, and
// returns the full locale → column id map (existing columns included). Idempotent.
async function ensureLocaleColumns(boardId) {
  const columnData = await graphql(
    `query ($boardId: [ID!]) { boards(ids: $boardId) { columns { id title } } }`,
    { boardId: [boardId] }
  );
  const byTitle = new Map((columnData.boards[0]?.columns ?? []).map((c) => [c.title, c.id]));
  const ids = {};
  for (const [locale, label] of Object.entries(NON_EN_LOCALES)) {
    const title = localeColumnTitle(label);
    const existingId = byTitle.get(title);
    if (existingId) {
      console.error(`column "${title}" already exists (${existingId}) — skipping`);
      ids[locale] = existingId;
    } else {
      ids[locale] = await createColumnOn(boardId, title, 'long_text', localeColumnDescription(label));
    }
  }
  return ids;
}

// --add-locale-columns: upgrade an existing Letter Settings board in place, then print the
// bodyTemplatesByLocale block to merge into config/svbc.json.
if (upgradeBoardId) {
  const ids = await ensureLocaleColumns(upgradeBoardId);
  console.log(JSON.stringify({ bodyTemplatesByLocale: ids }, null, 2));
  console.error('\nMerge the bodyTemplatesByLocale block above into letterCron.columns in config/svbc.json.');
  process.exit(0);
}

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

const autoSendId = await createColumnOn(
  boardId,
  'Auto-send',
  'checkbox',
  'Master switch for the automatic January letter emails. While unchecked, the cron never sends.'
);
const startDateId = await createColumnOn(
  boardId,
  'Auto-send start date',
  'date',
  'The cron only sends on or after this date. It re-arms each January for the newly completed year, so move this date forward (or uncheck Auto-send) to delay a season.'
);
const bodyTemplateId = await createColumnOn(
  boardId,
  'Email body template',
  'long_text',
  'Plain text with {{donorName}}, {{year}}, {{loginUrl}} placeholders. The default for every letter-ready email (button and cron) — locales with their own template column override it. Blank = built-in copy in the donor’s language. Pasted HTML is shown literally, never rendered.'
);
const localeColumnIds = await ensureLocaleColumns(boardId);

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
        columns: {
          autoSend: autoSendId,
          startDate: startDateId,
          bodyTemplate: bodyTemplateId,
          bodyTemplatesByLocale: localeColumnIds,
        },
        maxTriggersPerRun: config.letterCron?.maxTriggersPerRun ?? 200,
      },
    },
    null,
    2
  )
);
console.error('\nPaste the letterCron block above into config/svbc.json, then grant the portal integration user read access to the new board.');
