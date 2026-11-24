#!/usr/bin/env node
// Checks that the two People boards have the same columns, by the same rule that stops a pass
// (src/columns.ts moveMapping), and with --apply creates the ones a board lacks: same title (marker
// included), same type, status labels at the same ids. Run it after adding any column to People or
// People (Historical); the nightly run refuses every move until the boards match. Safe to re-run.
//
//   MONDAY_API_TOKEN=... node scripts/match-people-columns.mjs --config config/<env>.json [--apply]
//
// Exit 0: the boards match. Exit 1: they don't (each difference is printed; a connect, dropdown or
// doc column has to be added by hand). Exit 2: usage or API error. Without --apply it only reads.

import { readFileSync } from 'node:fs';
import { MondayGraphQL } from '../src/monday/graphql.ts';
import { labelMismatches, planMatch } from './match-people-columns-lib.mjs';

const argOf = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const token = process.env.MONDAY_API_TOKEN;
const configPath = argOf('--config');
const apply = process.argv.includes('--apply');

async function main() {
  if (!token || !configPath) {
    console.error('usage: MONDAY_API_TOKEN=... node scripts/match-people-columns.mjs --config config/<env>.json [--apply]');
    return 2;
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const ids = [config.boards.live.boardId, config.boards.historical.boardId].map(String);
  const monday = new MondayGraphQL(config.monday.apiUrl, token);
  const readBoards = async () => {
    const { boards } = await monday.request('query ($ids: [ID!]) { boards(ids: $ids) { id name columns { id title type settings_str } } }', { ids });
    const found = ids.map((id) => boards.find((b) => b.id === id));
    if (found.includes(undefined)) throw new Error('a People board is not visible to this token');
    return found;
  };

  let boards = await readBoards();
  let plan = planMatch(...boards);
  const name = (id) => boards.find((b) => b.id === id).name;
  const print = () => {
    for (const c of plan.create) console.log(`${name(c.boardId)} lacks "${c.title}" (${c.type})${c.defaults ? ` ${JSON.stringify(c.defaults.labels)}` : ''}`);
    for (const c of plan.byHand) console.log(`${name(c.boardId)} lacks "${c.title}" (${c.type}); add it by hand: ${c.why}`);
    if (plan.create.length + plan.byHand.length === 0) console.log('the two People boards match');
  };
  print();
  if (apply && plan.create.length > 0) {
    const created = plan.create;
    for (const c of created) {
      const data = await monday.request(
        `mutation ($boardId: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
          create_column(board_id: $boardId, title: $title, column_type: $type, defaults: $defaults) { id }
        }`,
        { boardId: c.boardId, title: c.title, type: c.type, defaults: c.defaults && JSON.stringify(c.defaults) },
        // A create that may have committed mustn't be retried into a duplicate; a re-run re-reads.
        { idempotent: false },
      );
      console.log(`${name(c.boardId)}: created "${c.title}" ${data.create_column.id}`);
    }
    boards = await readBoards();
    plan = planMatch(...boards);
    print();
    const wrong = labelMismatches(created, boards);
    if (wrong.length > 0) {
      console.error(`labels are not at the ids asked for: ${wrong.join(', ')}`);
      return 1;
    }
  }
  return plan.create.length + plan.byHand.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e.message);
  process.exit(2);
});
