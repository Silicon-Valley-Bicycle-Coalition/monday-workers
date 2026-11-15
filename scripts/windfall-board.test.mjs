import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AmbiguousWriteError, MondayApiError } from '../monday-backup/src/monday/graphql.ts';
import { parseArgs, run, MAX_ITEM_PAGES } from './windfall-board.mjs';
import { WINDFALL_TITLES, FORBIDDEN_USERS } from './lib/windfall-board.mjs';

const TYPES = {
  'Windfall ID': 'text',
  'Net Worth': 'numbers',
  'Net Worth Low': 'numbers',
  'Net Worth High': 'numbers',
  'Net Worth Date': 'date',
  'Philanthropic Giver': 'checkbox',
  'Job Title': 'text',
  'Windfall Company': 'text',
  LinkedIn: 'link',
  'Windfall Priority': 'numbers',
  'Windfall Profile': 'long_text',
};

// Fake values only. Everything a report must never print holds SECRET or a number listed in LEAKS.
const FULL = {
  'Windfall ID': JSON.stringify('SECRET-wf'),
  'Net Worth': JSON.stringify('990001'),
  'Net Worth Low': JSON.stringify('990002'),
  'Net Worth High': JSON.stringify('990003'),
  'Net Worth Date': JSON.stringify({ date: '1999-09-09', changed_at: '2026-01-01T00:00:00Z' }),
  'Philanthropic Giver': JSON.stringify({ checked: 'true', changed_at: '2026-01-01T00:00:00Z' }),
  'Job Title': JSON.stringify('SECRET-title'),
  'Windfall Company': JSON.stringify('SECRET-company'),
  LinkedIn: JSON.stringify({ url: 'https://example.test/SECRET', text: 'SECRET-link' }),
  'Windfall Priority': JSON.stringify('990004'),
  'Windfall Profile': JSON.stringify({
    text: 'SECRET-profile\nFlags: Recent Mover, Recently Divorced',
    changed_at: '2026-01-01T00:00:00Z',
  }),
};
const LEAKS = ['SECRET', '990001', '990002', '990003', '990004', '1999-09-09', 'Recent Mover'];

const WS = '100';
const PEOPLE = '201';
const HIST = '202';
const NEW_BOARD = '9001';
const STAFF = ['1', '2', '3', '4'];

function sourceColumns(prefix, titlePrefix = '') {
  const cols = [{ id: `${prefix}_name`, title: 'Name', type: 'name' }];
  WINDFALL_TITLES.forEach((t, i) => {
    cols.push({ id: `${prefix}_c${i}`, title: `${titlePrefix}${t}`, type: TYPES[t] });
  });
  cols.push({ id: `${prefix}_other`, title: 'Lifetime Giving', type: 'numbers' });
  return cols;
}

function person(id, name, columns, raws) {
  const cells = {};
  for (const [title, value] of Object.entries(raws)) {
    const col = columns.find((c) => c.title === title || c.title === `📜 ${title}`);
    cells[col.id] = { value };
  }
  return { id, name, cells };
}

function world({ titlePrefix = '', peopleRows, histRows } = {}) {
  const w = {
    boards: new Map(),
    calls: [],
    nextId: Number(NEW_BOARD),
    createKind: 'private',
    pageSize: 500,
    seedItems: ['seed-1', 'seed-2'],
    users: FORBIDDEN_USERS.map((id) => ({ id, is_admin: false })),
    fail: null,
    before: null,
  };
  const peopleCols = sourceColumns('p', titlePrefix);
  const histCols = sourceColumns('h', titlePrefix);
  w.boards.set(PEOPLE, {
    id: PEOPLE,
    name: 'People',
    workspace: WS,
    state: 'active',
    kind: 'private',
    subscribers: ['1', FORBIDDEN_USERS[0]],
    teams: [],
    columns: peopleCols,
    items: peopleRows ?? [
      person('11', 'SECRET Name One', peopleCols, FULL),
      person('12', 'SECRET Name Two', peopleCols, { 'Job Title': JSON.stringify('SECRET-only-title') }),
      person('13', 'SECRET Name Empty', peopleCols, {}),
    ],
  });
  w.boards.set(HIST, {
    id: HIST,
    name: 'People (Historical)',
    workspace: WS,
    state: 'active',
    kind: 'private',
    subscribers: ['1'],
    teams: [],
    columns: histCols,
    items: histRows ?? [person('21', 'SECRET Name Three', histCols, FULL)],
  });
  w.gql = async (query, vars, opts) => {
    w.calls.push({ query, vars, opts });
    if (w.before) await w.before(query, vars, w);
    if (w.fail) {
      const thrown = w.fail(query, vars);
      if (thrown) throw thrown;
    }
    return answer(w, query, vars);
  };
  return w;
}

function page(w, board, offset, cols) {
  const slice = board.items.slice(offset, offset + w.pageSize);
  const next = offset + w.pageSize;
  return {
    cursor: next < board.items.length ? `${board.id}:${next}` : null,
    items: slice.map((item) => ({
      id: item.id,
      name: item.name,
      column_values: cols
        .filter((id) => board.columns.some((c) => c.id === id))
        .map((id) => {
          const col = board.columns.find((c) => c.id === id);
          const cell = item.cells[id] ?? {};
          if (col.type === 'board_relation') {
            // Monday's `value` is not the link list, and ids can come back as numbers.
            return { id, type: col.type, value: '{"SECRET":"not the links"}', linked_item_ids: cell.linked ?? [] };
          }
          return { id, type: col.type, value: cell.value ?? null };
        }),
    })),
  };
}

function answer(w, query, vars) {
  if (/create_board/.test(query)) {
    const id = String(w.nextId++);
    w.boards.set(id, {
      id,
      name: vars.name,
      workspace: vars.workspace,
      state: 'active',
      kind: w.createKind,
      subscribers: ['1'],
      teams: [],
      columns: [{ id: `${id}_name`, title: 'Name', type: 'name' }, ...(w.seedColumns ?? [])],
      items: w.seedItems.map((sid) => ({ id: sid, name: 'Task', cells: {} })),
    });
    return { create_board: { id } };
  }
  if (/create_column/.test(query)) {
    const board = w.boards.get(String(vars.board));
    const id = `${board.id}_col${board.columns.length}`;
    board.columns.push({ id, title: vars.title, type: vars.type, defaults: vars.defaults });
    return { create_column: { id } };
  }
  if (/create_item/.test(query)) {
    const board = w.boards.get(String(vars.board));
    const values = JSON.parse(vars.values);
    const cells = {};
    for (const [colId, v] of Object.entries(values)) {
      const col = board.columns.find((c) => c.id === colId);
      assert.ok(col, `create_item names an unknown column ${colId}`);
      if (col.type === 'board_relation') cells[colId] = { linked: v.item_ids };
      else cells[colId] = { value: JSON.stringify(v) };
    }
    const id = String(w.nextId++);
    board.items.push({ id, name: vars.name, cells });
    return { create_item: { id } };
  }
  if (/delete_item/.test(query)) {
    for (const board of w.boards.values()) board.items = board.items.filter((i) => i.id !== String(vars.id));
    return { delete_item: { id: vars.id } };
  }
  if (/delete_column/.test(query)) {
    const board = w.boards.get(String(vars.board));
    board.columns = board.columns.filter((c) => c.id !== vars.column);
    return { delete_column: { id: vars.column } };
  }
  if (/next_items_page/.test(query)) {
    const [boardId, offset] = vars.cursor.split(':');
    return { next_items_page: page(w, w.boards.get(boardId), Number(offset), vars.cols) };
  }
  if (/items_page/.test(query)) {
    assert.match(query, /limit: 500/);
    const board = w.boards.get(String(vars.ids[0]));
    return { boards: board ? [{ items_page: page(w, board, 0, vars.cols ?? []) }] : [] };
  }
  if (/users\(/.test(query)) {
    return { users: w.users.filter((u) => vars.ids.map(String).includes(String(u.id))) };
  }
  if (/workspace_ids/.test(query)) {
    const boards = [...w.boards.values()].filter((b) => b.workspace === String(vars.ws[0]));
    const start = (vars.page - 1) * vars.limit;
    return {
      boards: boards.slice(start, start + vars.limit).map((b) => ({
        id: b.id,
        name: b.name,
        state: b.state,
        board_kind: b.kind,
        subscribers: b.subscribers.map((id) => ({ id })),
        team_subscribers: b.teams.map((id) => ({ id })),
        columns: b.columns.map((c) => ({ title: c.title })),
      })),
    };
  }
  if (/columns\(ids/.test(query)) {
    const board = w.boards.get(String(vars.ids[0]));
    return { boards: [{ columns: board.columns.filter((c) => vars.column.includes(c.id)).map(({ id, title }) => ({ id, title })) }] };
  }
  if (/boards\(ids/.test(query)) {
    const board = w.boards.get(String(vars.ids[0]));
    if (!board) return { boards: [] };
    return {
      boards: [
        {
          id: Number(board.id), // ids can come back as numbers
          board_kind: board.kind,
          subscribers: board.subscribers.map((id) => ({ id: Number(id) })),
          team_subscribers: board.teams.map((id) => ({ id })),
          columns: board.columns.map(({ id, title, type }) => ({ id, title, type })),
        },
      ],
    };
  }
  throw new Error(`fake Monday: unexpected query ${query}`);
}

async function go(w, argv) {
  const lines = [];
  const code = await run(parseArgs(argv), { gql: w.gql, out: (l) => lines.push(l), err: (l) => lines.push(l) });
  return { code, text: lines.join('\n') };
}

const mutations = (w) => w.calls.filter((c) => /^\s*mutation/.test(c.query));
const named = (w, name) => mutations(w).filter((c) => c.query.includes(name));
const COPY = ['copy', '--workspace', WS, '--people', PEOPLE, '--historical', HIST];
const subs = STAFF.flatMap((id) => ['--subscriber', id]);
const VERIFY = ['verify', '--people', PEOPLE, '--historical', HIST, '--board', NEW_BOARD, ...subs];
const DELETE = ['delete-people-columns', '--people', PEOPLE, '--historical', HIST, '--board', NEW_BOARD, ...subs];

// A world after a real copy --apply with the right subscribers on the new board.
async function copied(options) {
  const w = world(options);
  const result = await go(w, [...COPY, '--apply']);
  assert.equal(result.code, 0, result.text);
  w.boards.get(NEW_BOARD).subscribers = [...STAFF];
  w.calls.length = 0;
  return w;
}

const assertNoLeak = (text) => {
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `output leaked ${leak}`);
  assert.ok(!/SECRET Name/.test(text), 'output leaked an item name');
  assert.ok(!/divorced|death in family/i.test(text), 'output named a removed flag');
};

describe('parseArgs', () => {
  it('parseArgs rejects an unknown flag and a non-numeric id', () => {
    assert.throws(() => parseArgs([...COPY, '--force']), /unknown/);
    assert.throws(() => parseArgs(['copy', '--workspace', 'x', '--people', '1', '--historical', '2']), /numeric/);
    assert.throws(() => parseArgs([...VERIFY, '--subscriber', 'abc']), /numeric/);
  });

  it('defaults to a dry run and the default name', () => {
    const a = parseArgs(COPY);
    assert.equal(a.command, 'copy');
    assert.equal(a.apply, false);
    assert.equal(a.name, 'Wealth Screening');
    assert.equal(a.board, null);
  });

  it('takes repeated and space-separated list flags', () => {
    assert.deepEqual(parseArgs(['inventory', '--workspace', '1', '2', '--workspace', '3']).workspaces, ['1', '2', '3']);
    assert.deepEqual(parseArgs([...VERIFY.slice(0, 7), '--subscriber', '1', '2']).subscribers, ['1', '2']);
  });

  it('rejects flags that are not for the command, so verify can never take --apply', () => {
    assert.throws(() => parseArgs([...VERIFY, '--apply']), /unknown/);
    assert.throws(() => parseArgs(['inventory', '--workspace', '1', '--apply']), /unknown/);
    assert.throws(() => parseArgs([...DELETE, '--force']), /unknown/);
  });

  it('requires what each command needs', () => {
    assert.throws(() => parseArgs([]), /command/);
    assert.throws(() => parseArgs(['nope']), /command/);
    assert.throws(() => parseArgs(['inventory']), /--workspace/);
    assert.throws(() => parseArgs(['copy', '--workspace', '1', '--people', '2']), /--historical/);
    assert.throws(() => parseArgs(['verify', '--people', '1', '--historical', '2', '--board', '3']), /--subscriber/);
    assert.throws(() => parseArgs(['copy', '--workspace', '1', '2', '--people', '3', '--historical', '4']), /--workspace/);
    assert.throws(() => parseArgs([...COPY, '--name', '']), /empty/);
    assert.throws(() => parseArgs([...COPY, '--people', '9']), /once/);
    assert.throws(() => parseArgs([...COPY, '--name', '--apply']), /--name/);
  });

  it('refuses a board id used for two roles', () => {
    assert.throws(() => parseArgs(['copy', '--workspace', '1', '--people', '2', '--historical', '2']), /different/);
    assert.throws(() => parseArgs(['verify', '--people', '2', '--historical', '3', '--board', '2', '--subscriber', '1']), /different/);
  });
});

describe('inventory', () => {
  it('lists boards in any state with a Windfall ID column, marked or not, by id only', async () => {
    const w = world({ titlePrefix: '📜 ' });
    w.boards.get(HIST).state = 'archived';
    w.boards.set('300', {
      id: '300', name: 'SECRET unrelated', workspace: WS, state: 'active', kind: 'public',
      subscribers: [], teams: [], columns: [{ id: 'x', title: 'Name', type: 'name' }], items: [],
    });
    const r = await go(w, ['inventory', '--workspace', WS]);
    assert.equal(r.code, 0);
    assert.match(r.text, new RegExp(`${PEOPLE}.*active.*private`));
    assert.match(r.text, new RegExp(`${HIST}.*archived.*private`));
    assert.match(r.text, new RegExp(FORBIDDEN_USERS[0]));
    assert.ok(!r.text.includes('300'));
    assert.deepEqual(mutations(w), []);
    assert.match(w.calls[0].query, /state: all/);
  });
});

describe('copy', () => {
  it('copy without --apply sends no mutation', async () => {
    const w = world();
    const r = await go(w, COPY);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(mutations(w), []);
    assert.match(r.text, /3 item/);
    assert.match(r.text, /[Aa]rchived/);
  });

  it('copy stops, dry run or not, on a profile the scrubber left a removed flag in', async () => {
    for (const text of ['Flags: Boat Owner; Recently Divorced', 'Flags - Recent Death in Family', 'Note: recently  divorced']) {
      const w = world();
      const col = w.boards.get(PEOPLE).columns.find((c) => c.title === 'Windfall Profile');
      w.boards.get(PEOPLE).items[0].cells[col.id] = { value: JSON.stringify({ text }) };
      for (const argv of [COPY, [...COPY, '--apply']]) {
        const r = await go(w, argv);
        assert.equal(r.code, 1, r.text);
        assert.match(r.text, /removed flag.*\b11\b/);
        assertNoLeak(r.text);
      }
      assert.deepEqual(mutations(w), []);
    }
  });

  it('copy prints a zero removed-flag count, dry run and apply', async () => {
    const w = world();
    assert.match((await go(w, COPY)).text, /Removed-flag check: 0 People profile/);
    assert.match((await go(w, [...COPY, '--apply'])).text, /Removed-flag check: 0 People profile/);
  });

  it('copy --board without --apply sends no mutation', async () => {
    const w = await copied();
    const r = await go(w, [...COPY, '--board', NEW_BOARD]);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(mutations(w), []);
  });

  it('copy refuses an existing board of that name when --board is absent', async () => {
    const w = world();
    w.boards.set('300', {
      id: '300', name: 'Wealth Screening', workspace: WS, state: 'archived', kind: 'private',
      subscribers: [], teams: [], columns: [], items: [],
    });
    const r = await go(w, [...COPY, '--apply']);
    assert.equal(r.code, 1);
    assert.match(r.text, /300/);
    assert.deepEqual(mutations(w), []);
  });

  it('copy names --board for a live clash, and only --name for a deleted one', async () => {
    const clash = (state) => ({
      id: '300', name: 'Wealth Screening', workspace: WS, state, kind: 'private',
      subscribers: [], teams: [], columns: [], items: [],
    });
    for (const state of ['active', 'archived']) {
      const w = world();
      w.boards.set('300', clash(state));
      const r = await go(w, COPY);
      assert.equal(r.code, 1);
      assert.match(r.text, /--board 300/);
      assert.match(r.text, /--name/);
    }
    const w = world();
    w.boards.set('300', clash('deleted'));
    const r = await go(w, COPY);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.text, /--board/);
    assert.match(r.text, /--name/);
    assert.match(r.text, /deleted/);
  });

  it('copy exits 1 if the created board does not read private', async () => {
    const w = world();
    w.createKind = 'public';
    const r = await go(w, [...COPY, '--apply']);
    assert.equal(r.code, 1);
    assert.match(r.text, new RegExp(NEW_BOARD));
    assert.equal(named(w, 'create_board').length, 1);
    assert.deepEqual(named(w, 'create_item'), []);
    assert.deepEqual(named(w, 'create_column'), []);
  });

  it('copy --board checks the board is private before writing anything', async () => {
    const w = await copied();
    w.boards.get(NEW_BOARD).kind = 'public';
    for (const argv of [[...COPY, '--board', NEW_BOARD], [...COPY, '--board', NEW_BOARD, '--apply']]) {
      const r = await go(w, argv);
      assert.equal(r.code, 1);
    }
    assert.deepEqual(mutations(w), []);
  });

  it('copy --board refuses an unknown board and one a forbidden user can read', async () => {
    const w = await copied();
    assert.equal((await go(w, [...COPY, '--board', '777', '--apply'])).code, 1);
    w.boards.get(NEW_BOARD).subscribers.push(FORBIDDEN_USERS[1]);
    assert.equal((await go(w, [...COPY, '--board', NEW_BOARD, '--apply'])).code, 1);
    assert.deepEqual(mutations(w), []);
  });

  it('copy run twice creates each person once', async () => {
    const w = await copied();
    const board = w.boards.get(NEW_BOARD);
    assert.equal(board.items.length, 3);
    const r = await go(w, [...COPY, '--board', NEW_BOARD, '--apply']);
    assert.equal(r.code, 0, r.text);
    assert.equal(board.items.length, 3);
    assert.deepEqual(named(w, 'create_item'), []);
    assert.deepEqual(named(w, 'create_column'), []);
  });

  it('copy finds marked titles: "📜 Net Worth" reads as Net Worth', async () => {
    const w = await copied({ titlePrefix: '📜 ' });
    const board = w.boards.get(NEW_BOARD);
    assert.equal(board.items.length, 3);
    const col = board.columns.find((c) => c.title === 'Net Worth');
    const item = board.items.find((i) => i.name === 'SECRET Name One');
    assert.equal(item.cells[col.id].value, FULL['Net Worth']);
    assert.equal((await go(w, VERIFY)).code, 0);
  });

  it('copy creates bare titles, source types, currency numbers and a Person link to both boards', async () => {
    const w = await copied({ titlePrefix: '📜 ' });
    const board = w.boards.get(NEW_BOARD);
    for (const t of WINDFALL_TITLES) {
      const col = board.columns.find((c) => c.title === t);
      assert.ok(col, t);
      assert.equal(col.type, TYPES[t]);
    }
    const currency = JSON.stringify({ unit: { symbol: '$', direction: 'left', precision: 2 } });
    for (const t of ['Net Worth', 'Net Worth Low', 'Net Worth High']) {
      assert.equal(board.columns.find((c) => c.title === t).defaults, currency);
    }
    assert.equal(board.columns.find((c) => c.title === 'Windfall Priority').defaults, undefined);
    const personCol = board.columns.find((c) => c.title === 'Person');
    assert.equal(personCol.type, 'board_relation');
    assert.deepEqual(JSON.parse(personCol.defaults), { boardIds: [Number(PEOPLE), Number(HIST)] });
  });

  it('copy deletes only the items it found on a board it just created, before its first create', async () => {
    const w = await copied();
    const board = w.boards.get(NEW_BOARD);
    assert.ok(board.items.every((i) => !i.id.startsWith('seed')));

    const w2 = world();
    await go(w2, [...COPY, '--apply']);
    const order = mutations(w2).map((c) => /(create_board|create_column|create_item|delete_item)/.exec(c.query)[1]);
    assert.equal(order.lastIndexOf('delete_item') < order.indexOf('create_item'), true);
    assert.deepEqual(named(w2, 'delete_item').map((c) => c.vars.id), ['seed-1', 'seed-2']);
  });

  it('copy stops before adding anything if Monday seeds a column that clashes, such as a people-type Person', async () => {
    const w = world();
    w.seedColumns = [{ id: 'seed_person', title: 'Person', type: 'people' }];
    const r = await go(w, [...COPY, '--apply']);
    assert.equal(r.code, 1);
    assert.match(r.text, /Person/);
    assert.match(r.text, new RegExp(`--board ${NEW_BOARD}`));
    assert.deepEqual(named(w, 'create_column'), []);
    assert.deepEqual(named(w, 'create_item'), []);
  });

  it('copy leaves a harmless seeded column alone', async () => {
    const w = world();
    w.seedColumns = [{ id: 'seed_status', title: 'Status', type: 'status' }];
    assert.equal((await go(w, [...COPY, '--apply'])).code, 0);
    assert.ok(w.boards.get(NEW_BOARD).columns.some((c) => c.id === 'seed_status'));
  });

  it('copy --board stops before any write if the board has rows and every link reads empty', async () => {
    const w = await copied();
    const board = w.boards.get(NEW_BOARD);
    const person = board.columns.find((c) => c.title === 'Person');
    for (const item of board.items) item.cells[person.id] = { linked: [] };
    for (const argv of [[...COPY, '--board', NEW_BOARD], [...COPY, '--board', NEW_BOARD, '--apply']]) {
      const r = await go(w, argv);
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, /3 row\(s\) scanned, 3 with no Person link/);
      assertNoLeak(r.text);
    }
    assert.deepEqual(mutations(w), []);
    assert.equal(board.items.length, 3);
  });

  it('copy --board stops before any write if the board has items and no Person column', async () => {
    const w = await copied();
    const board = w.boards.get(NEW_BOARD);
    board.columns = board.columns.filter((c) => c.title !== 'Person');
    for (const argv of [[...COPY, '--board', NEW_BOARD], [...COPY, '--board', NEW_BOARD, '--apply']]) {
      const r = await go(w, argv);
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, /3 row\(s\) scanned, 3 with no Person link/);
    }
    assert.deepEqual(mutations(w), []);
  });

  it('copy --board still resumes on an empty board, with or without a Person column', async () => {
    const empty = await copied();
    empty.boards.get(NEW_BOARD).items = [];
    assert.equal((await go(empty, [...COPY, '--board', NEW_BOARD, '--apply'])).code, 0);
    assert.equal(empty.boards.get(NEW_BOARD).items.length, 3);

    const noPerson = await copied();
    const board = noPerson.boards.get(NEW_BOARD);
    board.items = [];
    board.columns = board.columns.filter((c) => c.title !== 'Person');
    assert.equal((await go(noPerson, [...COPY, '--board', NEW_BOARD, '--apply'])).code, 0);
    assert.equal(board.items.length, 3);
    assert.equal(board.columns.filter((c) => c.title === 'Person').length, 1);
  });

  it('copy --board never deletes items on a board it did not create', async () => {
    const w = await copied();
    const board = w.boards.get(NEW_BOARD);
    board.items.push({ id: 'staff-row', name: 'kept', cells: {} });
    const dry = await go(w, [...COPY, '--board', NEW_BOARD]);
    assert.equal(dry.code, 0, dry.text);
    assert.match(dry.text, /4 row\(s\) scanned, 1 with no Person link/);
    const applied = await go(w, [...COPY, '--board', NEW_BOARD, '--apply']);
    assert.equal(applied.code, 0, applied.text);
    assert.match(applied.text, /4 row\(s\) scanned, 1 with no Person link/);
    assert.deepEqual(named(w, 'delete_item'), []);
    assert.ok(board.items.some((i) => i.id === 'staff-row'));
  });

  it('copy writes through valueToWrite: the profile loses its removed flags, skips empties', async () => {
    const w = await copied();
    const board = w.boards.get(NEW_BOARD);
    const profile = board.columns.find((c) => c.title === 'Windfall Profile');
    const item = board.items.find((i) => i.name === 'SECRET Name One');
    assert.deepEqual(JSON.parse(item.cells[profile.id].value), { text: 'SECRET-profile\nFlags: Recent Mover' });
    const two = board.items.find((i) => i.name === 'SECRET Name Two');
    assert.equal(two.cells[profile.id], undefined);
    const person = board.columns.find((c) => c.title === 'Person');
    assert.deepEqual(two.cells[person.id].linked, [12]);
  });

  it('copy fails on a missing or doubled title, on either People board, before any write', async () => {
    const missing = world();
    missing.boards.get(HIST).columns = missing.boards.get(HIST).columns.filter((c) => c.title !== 'LinkedIn');
    const a = await go(missing, [...COPY, '--apply']);
    assert.equal(a.code, 1);
    assert.match(a.text, /LinkedIn/);
    assert.deepEqual(mutations(missing), []);

    const doubled = world();
    doubled.boards.get(PEOPLE).columns.push({ id: 'dup', title: '📜 Net Worth', type: 'numbers' });
    const b = await go(doubled, [...COPY, '--apply']);
    assert.equal(b.code, 1);
    assert.match(b.text, /Net Worth/);
    assert.deepEqual(mutations(doubled), []);
  });

  it('copy fails when the People boards disagree on a column type', async () => {
    const w = world();
    w.boards.get(HIST).columns.find((c) => c.title === 'Job Title').type = 'long_text';
    const r = await go(w, [...COPY, '--apply']);
    assert.equal(r.code, 1);
    assert.match(r.text, /Job Title/);
    assert.deepEqual(mutations(w), []);
  });

  it('copy --board fails on a doubled title, a wrong type, or a Person that is not board_relation', async () => {
    const cases = [
      (b) => b.columns.push({ id: 'dup', title: '📜 Windfall ID', type: 'text' }),
      (b) => { b.columns.find((c) => c.title === 'Job Title').type = 'long_text'; },
      (b) => { b.columns.find((c) => c.title === 'Person').type = 'text'; },
    ];
    for (const change of cases) {
      const w = await copied();
      change(w.boards.get(NEW_BOARD));
      assert.equal((await go(w, [...COPY, '--board', NEW_BOARD, '--apply'])).code, 1);
      assert.deepEqual(mutations(w), []);
    }
  });

  it('copy stops before any write on a cell it cannot read, naming only the item id', async () => {
    const w = world();
    const col = w.boards.get(PEOPLE).columns.find((c) => c.title === 'LinkedIn');
    w.boards.get(PEOPLE).items[0].cells[col.id] = { value: '{"SECRET": true}' };
    const r = await go(w, [...COPY, '--apply']);
    assert.equal(r.code, 1);
    assert.match(r.text, /\b11\b/);
    assertNoLeak(r.text);
    assert.deepEqual(mutations(w), []);
  });

  it('an AmbiguousWriteError stops the copy, tells the operator to re-run, and exits 2', async () => {
    const w = world();
    let creates = 0;
    w.fail = (query) => {
      if (query.includes('create_item') && ++creates === 2) return new AmbiguousWriteError('monday API: SECRET echoed');
      return null;
    };
    const r = await go(w, [...COPY, '--apply']);
    assert.equal(r.code, 2);
    assert.match(r.text, /may or may not have committed/);
    assert.match(r.text, /re-run/i);
    assert.match(r.text, new RegExp(`--board ${NEW_BOARD}`));
    assert.equal(named(w, 'create_item').length, 2);
    assertNoLeak(r.text);
    // The re-run finishes the job: the second person was not created, so it is created now.
    w.fail = null;
    const again = await go(w, [...COPY, '--board', NEW_BOARD, '--apply']);
    assert.equal(again.code, 0, again.text);
    assert.equal(w.boards.get(NEW_BOARD).items.length, 3);
  });

  it('an ambiguous create_board stops with no --board to suggest and exits 2', async () => {
    const w = world();
    w.fail = (query) => (query.includes('create_board') ? new AmbiguousWriteError('monday API: x') : null);
    const r = await go(w, [...COPY, '--apply']);
    assert.equal(r.code, 2);
    assert.match(r.text, /create_board/);
    assert.deepEqual(named(w, 'create_column'), []);
  });

  it('a failed item write prints the item id and a generic reason, never the Monday message', async () => {
    const w = world();
    w.fail = (query, vars) =>
      query.includes('create_item') ? new Error(`bad value ${vars.values} SECRET-thrown`) : null;
    const r = await go(w, [...COPY, '--apply']);
    assert.equal(r.code, 2);
    assert.match(r.text, /\b11\b/);
    assertNoLeak(r.text);
  });

  it('a Monday code and status are kept, the message is not', async () => {
    const w = world();
    w.fail = (query) =>
      query.includes('create_item')
        ? new MondayApiError('monday API: SECRET', { httpStatus: 200, code: 'ColumnValueException' })
        : null;
    const r = await go(w, [...COPY, '--apply']);
    assert.equal(r.code, 2);
    assert.match(r.text, /ColumnValueException/);
    assertNoLeak(r.text);
  });

  it('any other failed call exits 2 without forwarding its message', async () => {
    const w = world();
    w.fail = (query) => (query.includes('items_page') ? new Error('SECRET read failure') : null);
    const r = await go(w, COPY);
    assert.equal(r.code, 2);
    assert.match(r.text, /unexpected error/i);
    assert.doesNotMatch(r.text, /Monday call failed/);
    assertNoLeak(r.text);
  });

  it('a MondayApiError still reads as a failed Monday call', async () => {
    const w = world();
    w.fail = (query) => (query.includes('items_page') ? new MondayApiError('monday API: SECRET', { httpStatus: 500 }) : null);
    const r = await go(w, COPY);
    assert.equal(r.code, 2);
    assert.match(r.text, /Monday call failed \(HTTP 500\)/);
    assertNoLeak(r.text);
  });

  it('reads pages past the first and requests only the 11 columns', async () => {
    const w = world();
    w.pageSize = 2;
    const r = await go(w, [...COPY, '--apply']);
    assert.equal(r.code, 0, r.text);
    assert.equal(w.boards.get(NEW_BOARD).items.length, 3);
    const reads = w.calls.filter((c) => /next_items_page/.test(c.query));
    assert.ok(reads.length > 0);
    const peopleRead = w.calls.find((c) => /items_page/.test(c.query) && String(c.vars.ids?.[0]) === PEOPLE);
    assert.equal(peopleRead.vars.cols.length, 11);
    assert.ok(!peopleRead.vars.cols.includes('p_other'));
  });

  it('exits 2 rather than truncating when the page cap would be hit', async () => {
    const w = world();
    w.pageSize = 1;
    const cols = w.boards.get(PEOPLE).columns;
    w.boards.get(PEOPLE).items = Array.from({ length: MAX_ITEM_PAGES + 1 }, (_, i) =>
      person(String(1000 + i), `SECRET ${i}`, cols, {}),
    );
    const r = await go(w, COPY);
    assert.equal(r.code, 2);
    assert.match(r.text, /cap|pages/i);
  });

  it('exits 2 if Monday omits a requested cell, since an absent cell would read as empty', async () => {
    const w = world();
    const real = w.gql;
    w.gql = async (query, vars, opts) => {
      const data = await real(query, vars, opts);
      if (data.boards?.[0]?.items_page) {
        for (const item of data.boards[0].items_page.items) item.column_values = item.column_values.slice(1);
      }
      return data;
    };
    const r = await go(w, COPY);
    assert.equal(r.code, 2);
  });
});

describe('verify', () => {
  it('passes on a clean copy with the right subscribers, sending no mutation', async () => {
    const w = await copied();
    const r = await go(w, VERIFY);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(mutations(w), []);
    assert.match(r.text, /Result: clean/);
    assert.match(r.text, /[Aa]rchived/);
  });

  it('verify fails on a forbidden subscriber, an extra subscriber, a team subscriber, a public board, and a forbidden user who is an admin', async () => {
    const cases = {
      'forbidden subscriber': (w) => w.boards.get(NEW_BOARD).subscribers.push(FORBIDDEN_USERS[0]),
      'extra subscriber': (w) => w.boards.get(NEW_BOARD).subscribers.push('55'),
      'absent subscriber': (w) => w.boards.get(NEW_BOARD).subscribers.pop(),
      'team subscriber': (w) => w.boards.get(NEW_BOARD).teams.push('66'),
      'public board': (w) => { w.boards.get(NEW_BOARD).kind = 'public'; },
      'share board': (w) => { w.boards.get(NEW_BOARD).kind = 'share'; },
      'forbidden admin': (w) => { w.users[1].is_admin = true; },
      'admin unknown': (w) => { w.users[0].is_admin = null; },
    };
    for (const [label, change] of Object.entries(cases)) {
      const w = await copied();
      change(w);
      assert.equal((await go(w, VERIFY)).code, 1, label);
    }
  });

  it('verify tolerates SVBC Integration being an account admin, but not Sandbox Integration or an unknown answer', async () => {
    const w = await copied();
    w.users[0].is_admin = true;
    const r = await go(w, VERIFY);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, new RegExp(`${FORBIDDEN_USERS[0]} is an account admin; tolerated`));
    w.boards.get(NEW_BOARD).subscribers.push(FORBIDDEN_USERS[0]);
    assert.equal((await go(w, VERIFY)).code, 1, 'admin and subscribed');
  });

  it('a forbidden user passed as --subscriber still fails', async () => {
    const w = await copied();
    w.boards.get(NEW_BOARD).subscribers.push(FORBIDDEN_USERS[0]);
    const r = await go(w, [...VERIFY, '--subscriber', FORBIDDEN_USERS[0]]);
    assert.equal(r.code, 1);
  });

  it('one forbidden user the API does not return is only printed, unless subscribed', async () => {
    const w = await copied();
    w.users = w.users.slice(1);
    const r = await go(w, VERIFY);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, new RegExp(`${FORBIDDEN_USERS[0]}.*not found`));
    w.boards.get(NEW_BOARD).subscribers.push(FORBIDDEN_USERS[0]);
    assert.equal((await go(w, VERIFY)).code, 1);
  });

  it('fails if the API returns neither forbidden user: an empty answer proves nothing', async () => {
    const w = await copied();
    w.users = [];
    const r = await go(w, VERIFY);
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /neither forbidden user/i);
  });

  it('fails on a value that differs, a missing item, a duplicate and an unlinked item', async () => {
    const cases = {
      differs: (b) => {
        const col = b.columns.find((c) => c.title === 'Net Worth');
        b.items[0].cells[col.id] = { value: JSON.stringify('5') };
      },
      missing: (b) => b.items.pop(),
      duplicate: (b) => b.items.push({ ...b.items[0], id: 'dup' }),
      unlinked: (b) => b.items.push({ id: 'seed-1', name: 'Task', cells: {} }),
      'flag still on the board': (b) => {
        const col = b.columns.find((c) => c.title === 'Windfall Profile');
        b.items[0].cells[col.id] = { value: JSON.stringify({ text: 'SECRET\nFlags: Recently Divorced' }) };
      },
    };
    for (const [label, change] of Object.entries(cases)) {
      const w = await copied();
      change(w.boards.get(NEW_BOARD));
      const r = await go(w, VERIFY);
      assert.equal(r.code, 1, label);
      assertNoLeak(r.text);
    }
  });

  it('says where each problem is, in ids and titles', async () => {
    const differs = await copied();
    const board = differs.boards.get(NEW_BOARD);
    const job = board.columns.find((c) => c.title === 'Job Title');
    const row = board.items.find((i) => i.name === 'SECRET Name One');
    row.cells[job.id] = { value: JSON.stringify('SECRET-edited') };
    const a = await go(differs, VERIFY);
    assert.equal(a.code, 1);
    assert.match(a.text, new RegExp(`Mismatch: People item 11, board item ${row.id}: Job Title`));
    assertNoLeak(a.text);

    const gone = await copied();
    const goneBoard = gone.boards.get(NEW_BOARD);
    const person = goneBoard.columns.find((c) => c.title === 'Person');
    goneBoard.items = goneBoard.items.filter((i) => i.cells[person.id].linked[0] !== 21);
    goneBoard.items.push({ ...goneBoard.items[0], id: 'dup-row' }, { id: 'loose-row', name: 'SECRET Name Loose', cells: {} });
    const b = await go(gone, VERIFY);
    assert.equal(b.code, 1);
    assert.match(b.text, /Missing: People item 21/);
    assert.match(b.text, new RegExp(`Duplicate: People item 11 on board items ${goneBoard.items[0].id}, dup-row`));
    assert.match(b.text, /Extra: board item loose-row/);
    assertNoLeak(b.text);
  });

  it('after a mismatch, deleting the listed row and re-running copy comes back clean', async () => {
    const w = await copied();
    const board = w.boards.get(NEW_BOARD);
    const job = board.columns.find((c) => c.title === 'Job Title');
    const row = board.items.find((i) => i.name === 'SECRET Name Two');
    row.cells[job.id] = { value: JSON.stringify('SECRET-edited') };
    assert.equal((await go(w, VERIFY)).code, 1);
    board.items = board.items.filter((i) => i.id !== row.id);
    const again = await go(w, [...COPY, '--board', NEW_BOARD, '--apply']);
    assert.equal(again.code, 0, again.text);
    assert.equal((await go(w, VERIFY)).code, 0);
  });

  it('fails on a removed flag on the board that matches People, naming the board item', async () => {
    const w = await copied();
    const peopleBoard = w.boards.get(PEOPLE);
    const board = w.boards.get(NEW_BOARD);
    const peopleProfile = peopleBoard.columns.find((c) => c.title === 'Windfall Profile');
    const boardProfile = board.columns.find((c) => c.title === 'Windfall Profile');
    const row = board.items.find((i) => i.name === 'SECRET Name One');
    // The scrubber leaves this form alone, so reconcile sees both sides equal.
    const missed = JSON.stringify({ text: 'SECRET\nFlags: Boat Owner; Recently Divorced' });
    peopleBoard.items[0].cells[peopleProfile.id] = { value: missed };
    row.cells[boardProfile.id] = { value: missed };
    const r = await go(w, VERIFY);
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /Result: clean/);
    assert.match(r.text, new RegExp(`removed flag.*${row.id}`));
    assertNoLeak(r.text);
    const d = await go(w, [...DELETE, '--apply']);
    assert.equal(d.code, 1);
    assert.deepEqual(named(w, 'delete_column'), []);
  });

  it('reports a zero removed-flag count when there are none', async () => {
    const w = await copied();
    const r = await go(w, VERIFY);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /Removed-flag check: 0 board profile/);
  });

  it('refuses a vacuous check: zero people read in total, or an empty board', async () => {
    const w = await copied();
    w.boards.get(PEOPLE).items = [];
    w.boards.get(HIST).items = [];
    w.boards.get(NEW_BOARD).items = [];
    const r = await go(w, VERIFY);
    assert.equal(r.code, 1);
    assert.match(r.text, /zero people/i);
  });

  it('fails if either People board reads zero, even when the other does not', async () => {
    for (const id of [PEOPLE, HIST]) {
      const w = await copied();
      w.boards.get(id).items = [];
      const r = await go(w, VERIFY);
      assert.equal(r.code, 1, id);
      assert.match(r.text, new RegExp(`Board ${id}.*zero people`, 'i'));
    }
  });

  it('fails on a missing or doubled title on any board, Person missing or not board_relation, a type difference', async () => {
    const cases = {
      'people missing': (w) => {
        const b = w.boards.get(PEOPLE);
        b.columns = b.columns.filter((c) => c.title !== 'Net Worth Date');
      },
      'historical doubled': (w) => w.boards.get(HIST).columns.push({ id: 'dup', title: '🔒 LinkedIn', type: 'link' }),
      'board missing': (w) => {
        const b = w.boards.get(NEW_BOARD);
        b.columns = b.columns.filter((c) => c.title !== 'Windfall Company');
      },
      'board doubled': (w) => w.boards.get(NEW_BOARD).columns.push({ id: 'dup', title: 'Net Worth', type: 'numbers' }),
      'person missing': (w) => {
        const b = w.boards.get(NEW_BOARD);
        b.columns = b.columns.filter((c) => c.title !== 'Person');
      },
      'person wrong type': (w) => { w.boards.get(NEW_BOARD).columns.find((c) => c.title === 'Person').type = 'text'; },
      'board type differs': (w) => { w.boards.get(NEW_BOARD).columns.find((c) => c.title === 'Job Title').type = 'long_text'; },
      'people types differ': (w) => { w.boards.get(HIST).columns.find((c) => c.title === 'Job Title').type = 'long_text'; },
      'board gone': (w) => { w.boards.delete(NEW_BOARD); },
    };
    for (const [label, change] of Object.entries(cases)) {
      const w = await copied();
      change(w);
      assert.equal((await go(w, VERIFY)).code, 1, label);
    }
  });
});

describe('delete-people-columns', () => {
  it('delete-people-columns sends no delete_column when verify fails', async () => {
    const breakers = [
      (w) => { w.boards.get(NEW_BOARD).kind = 'public'; },
      (w) => w.boards.get(NEW_BOARD).subscribers.push(FORBIDDEN_USERS[0]),
      (w) => { w.boards.get(NEW_BOARD).items.pop(); },
      (w) => { w.users[1].is_admin = true; },
      (w) => { w.users = []; },
      (w) => {
        const b = w.boards.get(PEOPLE);
        b.columns = b.columns.filter((c) => c.title !== 'LinkedIn');
      },
      (w) => {
        for (const id of [PEOPLE, HIST, NEW_BOARD]) w.boards.get(id).items = [];
      },
    ];
    for (const change of breakers) {
      const w = await copied();
      change(w);
      const r = await go(w, [...DELETE, '--apply']);
      assert.equal(r.code, 1);
      assert.deepEqual(mutations(w), []);
    }
  });

  it('delete-people-columns without --apply sends no mutation', async () => {
    const w = await copied({ titlePrefix: '📜 ' });
    const r = await go(w, DELETE);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(mutations(w), []);
    assert.match(r.text, /p_c0/);
    assert.match(r.text, /h_c10/);
    assert.match(r.text, /Windfall Profile/);
    assert.match(r.text, /[Aa]rchived/);
  });

  it('delete-people-columns deletes only the 11 titles, on both boards', async () => {
    const w = await copied({ titlePrefix: '📜 ' });
    const r = await go(w, [...DELETE, '--apply']);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(mutations(w).map((c) => /delete_column/.test(c.query)), Array(22).fill(true));
    for (const [id, prefix] of [[PEOPLE, 'p'], [HIST, 'h']]) {
      assert.deepEqual(
        w.boards.get(id).columns.map((c) => c.id),
        [`${prefix}_name`, `${prefix}_other`],
      );
    }
    assert.equal(w.boards.get(NEW_BOARD).columns.filter((c) => c.title === 'Net Worth').length, 1);
    assert.equal(w.boards.get(NEW_BOARD).items.length, 3);
  });

  it('re-runs the whole verify in the same process right before the first delete', async () => {
    const w = await copied();
    await go(w, [...DELETE, '--apply']);
    const first = w.calls.findIndex((c) => /delete_column/.test(c.query));
    const before = w.calls.slice(0, first);
    assert.ok(before.some((c) => /users\(/.test(c.query)));
    for (const id of [PEOPLE, HIST, NEW_BOARD]) {
      assert.ok(before.some((c) => /items_page/.test(c.query) && String(c.vars.ids?.[0]) === id), id);
    }
  });

  it('a board change appearing just before apply stops it: nothing reuses an earlier verify', async () => {
    const w = await copied();
    w.before = (query, vars, world_) => {
      // The value changes at the moment the board is read for the check.
      if (/items_page/.test(query) && String(vars.ids?.[0]) === NEW_BOARD) world_.boards.get(NEW_BOARD).items.pop();
    };
    assert.equal((await go(w, [...DELETE, '--apply'])).code, 1);
    assert.deepEqual(mutations(w), []);
  });

  it('checks the title at delete time and stops if a column id now holds another title', async () => {
    const w = await copied();
    let renamed = false;
    w.before = (query, vars, world_) => {
      if (/columns\(ids/.test(query) && !renamed) {
        renamed = true;
        const col = world_.boards.get(PEOPLE).columns.find((c) => c.id === vars.column[0]);
        col.title = 'Lifetime Giving';
      }
    };
    const r = await go(w, [...DELETE, '--apply']);
    assert.equal(r.code, 1);
    assert.deepEqual(named(w, 'delete_column'), []);
    assert.equal(w.boards.get(PEOPLE).columns.length, 13);
  });

  it('never deletes on the new board or any id outside the resolved set', async () => {
    const w = await copied();
    await go(w, [...DELETE, '--apply']);
    const expected = new Set();
    for (const p of ['p', 'h']) WINDFALL_TITLES.forEach((_, i) => expected.add(`${p}_c${i}`));
    for (const c of named(w, 'delete_column')) {
      assert.ok(expected.has(c.vars.column), c.vars.column);
      assert.ok([PEOPLE, HIST].includes(String(c.vars.board)));
    }
    assert.equal(named(w, 'delete_column').length, 22);
  });

  it('exits 1 if a re-read still shows a column', async () => {
    const w = await copied();
    const real = w.gql;
    const col = { ...w.boards.get(PEOPLE).columns[1] };
    w.gql = async (query, vars, opts) => {
      const data = await real(query, vars, opts);
      if (/delete_column/.test(query)) w.deletes = (w.deletes ?? 0) + 1;
      if (w.deletes === 22 && /boards\(ids/.test(query) && String(vars.ids[0]) === PEOPLE) {
        data.boards[0].columns.push({ id: col.id, title: col.title, type: col.type });
      }
      return data;
    };
    const r = await go(w, [...DELETE, '--apply']);
    assert.equal(r.code, 1);
    assert.match(r.text, /remain/i);
  });

  it('a delete that may or may not have run stops, says what is left, and exits 2', async () => {
    const w = await copied();
    let n = 0;
    w.fail = (query) => (/delete_column/.test(query) && ++n === 3 ? new AmbiguousWriteError('monday API: SECRET') : null);
    const r = await go(w, [...DELETE, '--apply']);
    assert.equal(r.code, 2);
    assert.match(r.text, /2 of 22/);
    assertNoLeak(r.text);
    assert.equal(named(w, 'delete_column').length, 3);
    // The third column, p_c2, is the one in doubt: it isn't called deleted or not deleted.
    assert.match(r.text, new RegExp(`Board ${PEOPLE} column p_c2 \\(Net Worth Low\\) may or may not be gone`));
    const notDeleted = /Not deleted: (.*?)\. /.exec(r.text)[1];
    assert.doesNotMatch(notDeleted, /p_c2/);
    assert.match(notDeleted, new RegExp(`board ${PEOPLE} column p_c3 \\(Net Worth High\\)`));
    assert.match(notDeleted, new RegExp(`board ${HIST} column h_c10 \\(Windfall Profile\\)`));
  });

  it('a delete that plainly failed lists that column as not deleted, with board and title', async () => {
    const w = await copied();
    let n = 0;
    w.fail = (query) =>
      /delete_column/.test(query) && ++n === 2 ? new MondayApiError('monday API: SECRET', { httpStatus: 500 }) : null;
    const r = await go(w, [...DELETE, '--apply']);
    assert.equal(r.code, 2);
    assert.match(r.text, /1 of 22/);
    const notDeleted = /Not deleted: (.*?)\. /.exec(r.text)[1];
    assert.match(notDeleted, new RegExp(`^board ${PEOPLE} column p_c1 \\(Net Worth\\)`));
    assert.doesNotMatch(r.text, /may or may not/);
    assertNoLeak(r.text);
  });

  it('a delete stopped by a renamed column lists what is left with board and title', async () => {
    const w = await copied();
    let n = 0;
    w.before = (query, vars, world_) => {
      if (/columns\(ids/.test(query) && ++n === 2) {
        world_.boards.get(PEOPLE).columns.find((c) => c.id === vars.column[0]).title = 'Lifetime Giving';
      }
    };
    const r = await go(w, [...DELETE, '--apply']);
    assert.equal(r.code, 1);
    assert.match(r.text, /1 of 22/);
    assert.match(r.text, new RegExp(`Not deleted: board ${PEOPLE} column p_c1 \\(Net Worth\\)`));
  });
});

describe('snapshot-counts', () => {
  const SCRIPT = fileURLToPath(new URL('./windfall-board.mjs', import.meta.url));
  const header = JSON.stringify({
    type: 'board',
    board: { id: PEOPLE, name: 'SECRET Name Board', workspaceId: WS },
    schema: {
      columns: WINDFALL_TITLES.map((t, i) => ({ id: `c${i}`, title: t, type: TYPES[t], settingsStr: '{}' })),
      groups: [],
    },
  });
  const itemLine = (id, raws) =>
    JSON.stringify({
      type: 'item',
      item: {
        id,
        name: 'SECRET Name One',
        columnValues: WINDFALL_TITLES.map((t, i) => ({ id: `c${i}`, type: TYPES[t], text: 'SECRET', value: raws[t] ?? null })),
      },
    });
  const file = [header, itemLine('11', FULL), itemLine('12', {}), JSON.stringify({ type: 'update', update: { id: 'u', body: 'SECRET' } })];
  // Run as an operator does: no token in the environment, the file on stdin.
  const cli = (input) =>
    spawnSync(process.execPath, [SCRIPT, 'snapshot-counts'], { input, encoding: 'utf8', env: { PATH: process.env.PATH } });

  it('needs no flags, and takes none', () => {
    assert.equal(parseArgs(['snapshot-counts']).command, 'snapshot-counts');
    assert.throws(() => parseArgs(['snapshot-counts', '--apply']), /unknown/);
    assert.throws(() => parseArgs(['snapshot-counts', '--board', '1']), /unknown/);
  });

  it('prints per-title counts from stdin with no token, no Monday call and no value', () => {
    const r = cli(`${file.join('\n')}\n`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Board ${PEOPLE}: 2 item`));
    assert.match(r.stdout, /Net Worth: 1/);
    assert.match(r.stdout, /Windfall Profile: 1/);
    assertNoLeak(r.stdout + r.stderr);
  });

  it('runs through run() without gql', async () => {
    const lines = [];
    const code = await run(parseArgs(['snapshot-counts']), { lines: file, out: (l) => lines.push(l), err: (l) => lines.push(l) });
    assert.equal(code, 0);
    assertNoLeak(lines.join('\n'));
  });

  it('exits 2 on a malformed or unknown line, naming the line and not quoting it', () => {
    for (const bad of ['{"SECRET": oops', JSON.stringify({ type: 'SECRET' }), JSON.stringify({ type: 'block', block: { id: 'SECRET' } })]) {
      const r = cli(`${header}\n${bad}\n`);
      assert.equal(r.status, 2, bad);
      assert.match(r.stderr, /Line 2/);
      assertNoLeak(r.stdout + r.stderr);
    }
  });

  it('exits 2 on empty input', () => {
    const r = cli('');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /board header/i);
  });

  it('exits 2 and stops early on a bad first line with more behind it', () => {
    const r = cli(`{SECRET\n${file.join('\n')}\n`.repeat(2000));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Line 1/);
    assertNoLeak(r.stdout + r.stderr);
  });

  it('exits 1 when the board lacks one of the 11 titles, still printing the rest', () => {
    const lacking = JSON.parse(header);
    lacking.schema.columns = lacking.schema.columns.filter((c) => c.title !== 'LinkedIn');
    const r = cli(`${JSON.stringify(lacking)}\n`);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Net Worth: 0/);
    assert.match(r.stderr, /LinkedIn/);
  });
});

describe('no value reaches the output', () => {
  it('no command prints a value: stdout and stderr across a full run contain no "SECRET" fixture value', async () => {
    const w = world({ titlePrefix: '📜 ' });
    const lines = [];
    const sink = { gql: w.gql, out: (l) => lines.push(`out ${l}`), err: (l) => lines.push(`err ${l}`) };
    await run(parseArgs(['inventory', '--workspace', WS]), sink);
    await run(parseArgs(COPY), sink);
    assert.equal(await run(parseArgs([...COPY, '--apply']), sink), 0);
    w.boards.get(NEW_BOARD).subscribers = [...STAFF];
    await run(parseArgs([...COPY, '--board', NEW_BOARD]), sink);
    assert.equal(await run(parseArgs(VERIFY), sink), 0);
    await run(parseArgs(DELETE), sink);
    // And the failing paths, which print the most.
    const col = w.boards.get(NEW_BOARD).columns.find((c) => c.title === 'Job Title');
    w.boards.get(NEW_BOARD).items[0].cells[col.id] = { value: JSON.stringify('SECRET-changed') };
    assert.equal(await run(parseArgs(VERIFY), sink), 1);
    assert.equal(await run(parseArgs([...DELETE, '--apply']), sink), 1);
    assert.ok(lines.length > 0);
    assertNoLeak(lines.join('\n'));
  });
});
