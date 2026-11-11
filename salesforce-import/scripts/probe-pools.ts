// #50: measures what limits the load's link and archive passes, on a SANDBOX workspace only.
//
// Creates two scratch boards (people + donations with a connect column), then times
// change_multiple_column_values (the load's link write) and archive_item (its archive) at several
// pool sizes, reporting wall-clock throughput next to the client's own counters: per-request
// latency, retries by rejection reason, backoff, peak in flight. If throughput scales with pool
// size the limit is per-request latency; if retries/backoff dominate, Monday is rejecting
// concurrent requests. Archives the scratch boards at the end. Never hard-deletes anything.
//
//   MONDAY_API_TOKEN=... tsx scripts/probe-pools.ts --workspace 18210301 --check
//   MONDAY_API_TOKEN=... tsx scripts/probe-pools.ts --workspace 18210301 --run [--n 60] [--out probe.json]
//   ... --run --real [--donations "Donations (sandbox v3)"] [--people "People (sandbox v3)"] [--n 30]
//                            times single vs aliased(10) link and archive writes on a REAL
//                            full-size Donations board (its connect columns into People, its real
//                            column set), found by exact name inside --workspace, using throwaway
//                            items named "POOL-PROBE #50 ..." that are left archived on that board.
//   ... --run --only-extra   skips the pool-size sweep and runs two follow-ups: archives spread over
//                            several boards at once, and archives aliased 10 to a request
//
// --check is read-only: it prints the workspace's name and kind and exits. --run writes, and
// refuses unless the workspace id is the one you named and its name contains "sandbox".
import { writeFileSync } from 'node:fs';
import { MondayClient, type ClientStats } from '../src/load/monday.js';
import { runPool } from '../src/load/batch.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const workspaceId = arg('--workspace');
const n = Number(arg('--n') ?? 60);
const out = arg('--out');
if (!workspaceId || !/^\d+$/.test(workspaceId)) throw new Error('probe: --workspace <numeric id> is required');
if (!process.env.MONDAY_API_TOKEN) throw new Error('probe: MONDAY_API_TOKEN is not set');

const client = new MondayClient({ apiUrl: 'https://api.monday.com/v2', token: process.env.MONDAY_API_TOKEN });

async function checkWorkspace(): Promise<{ id: string; name: string; kind: string }> {
  const r = await client.gql<{ workspaces: { id: string; name: string; kind: string }[] }>(
    'query ($ids: [ID!]) { workspaces (ids: $ids) { id name kind } }', { ids: [workspaceId] });
  const w = r.workspaces[0];
  if (!w || String(w.id) !== workspaceId) throw new Error(`probe: workspace ${workspaceId} not found`);
  return w;
}

interface Row { phase: string; concurrency: number; items: number; wallMs: number; perMin: number; stats: ClientStats }
const rows: Row[] = [];

async function timed(phase: string, concurrency: number, items: number, fn: () => Promise<void>): Promise<void> {
  client.resetStats();
  const t0 = Date.now();
  await fn();
  const wallMs = Date.now() - t0;
  const row = { phase, concurrency, items, wallMs, perMin: Math.round((items / wallMs) * 60_000), stats: client.stats() };
  rows.push(row);
  const s = row.stats;
  console.log(`${phase.padEnd(8)} conc=${String(concurrency).padStart(2)}  ${items} items in ${(wallMs / 1000).toFixed(1)}s ` +
    `= ${row.perMin}/min  avg latency ${Math.round(s.latencyMsTotal / Math.max(1, s.requests - sum(s.retries)))}ms  ` +
    `requests ${s.requests}  retries ${JSON.stringify(s.retries)}  backoff ${Math.round(s.backoffMs)}ms  peak in-flight ${s.peakInFlight}`);
}
const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

async function createBoard(name: string): Promise<string> {
  const r = await client.gql<{ create_board: { id: string } }>(
    `mutation ($name: String!, $ws: ID) { create_board (board_name: $name, board_kind: public, workspace_id: $ws) { id } }`,
    { name, ws: workspaceId });
  return r.create_board.id;
}

async function createItems(boardId: string, prefix: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 10) {
    const size = Math.min(10, count - i);
    const vars = Array.from({ length: size }, (_, k) => `$n${k}: String!`).join(', ');
    const fields = Array.from({ length: size }, (_, k) =>
      `i${k}: create_item (board_id: $board, item_name: $n${k}) { id }`).join('\n');
    const variables: Record<string, unknown> = { board: boardId };
    for (let k = 0; k < size; k++) variables[`n${k}`] = `${prefix} ${i + k}`;
    const r = await client.gql<Record<string, { id: string }>>(
      `mutation ($board: ID!, ${vars}) { ${fields} }`, variables);
    for (let k = 0; k < size; k++) ids.push(r[`i${k}`]!.id);
  }
  return ids;
}

const aliasedLinks = async (boardId: string, colId: string, pairs: { id: string; person: string }[]): Promise<void> => {
  const variables: Record<string, unknown> = {};
  pairs.forEach((p, k) => {
    variables[`b${k}`] = boardId; variables[`i${k}`] = p.id;
    variables[`c${k}`] = JSON.stringify({ [colId]: { item_ids: [Number(p.person)] } });
  });
  await client.gql(`mutation (${pairs.map((_, k) => `$b${k}: ID!, $i${k}: ID!, $c${k}: JSON!`).join(', ')}) {
    ${pairs.map((_, k) => `l${k}: change_multiple_column_values (board_id: $b${k}, item_id: $i${k}, column_values: $c${k}, create_labels_if_missing: true) { id }`).join('\n')} }`, variables);
};
const aliasedArchives = async (ids: string[]): Promise<void> => {
  const variables: Record<string, unknown> = {};
  ids.forEach((id, k) => { variables[`i${k}`] = id; });
  await client.gql(`mutation (${ids.map((_, k) => `$i${k}: ID!`).join(', ')}) {
    ${ids.map((_, k) => `a${k}: archive_item (item_id: $i${k}) { id }`).join('\n')} }`, variables);
};
const groupsOf = <T>(xs: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
};

async function runReal(donName: string, pplName: string): Promise<void> {
  // Boards are found by exact name inside the named workspace, so the write can only land there.
  const found = await client.gql<{ boards: { id: string; name: string; workspace: { id: string } | null }[] }>(
    'query ($ws: [ID!]) { boards (workspace_ids: $ws, limit: 100, state: active) { id name workspace { id } } }',
    { ws: [workspaceId] });
  const pick = (name: string): string => {
    const m = found.boards.filter((x) => x.name === name && String(x.workspace?.id) === workspaceId);
    if (m.length !== 1) throw new Error(`probe: expected exactly one board named "${name}" in workspace ${workspaceId}, found ${m.length}`);
    return m[0]!.id;
  };
  const donId = pick(donName), pplId = pick(pplName);
  const cols = await client.gql<{ boards: { columns: { id: string; title: string; type: string }[] }[] }>(
    'query ($b: ID!) { boards (ids: [$b]) { columns { id title type } } }', { b: donId });
  const donorCol = cols.boards[0]!.columns.find((c) => c.title === 'Donor' && c.type === 'board_relation');
  if (!donorCol) throw new Error(`probe: "${donName}" has no Donor connect column`);
  const donor = donorCol.id;
  const pr = await client.gql<{ boards: { items_page: { items: { id: string }[] } }[] }>(
    'query ($b: ID!) { boards (ids: [$b]) { items_page (limit: 20) { items { id } } } }', { b: pplId });
  const people = pr.boards[0]!.items_page.items.map((i) => i.id);
  if (people.length === 0) throw new Error(`probe: "${pplName}" has no items to link to`);
  console.log(`real boards: "${donName}" ${donId} (${cols.boards[0]!.columns.length} columns), "${pplName}" ${pplId}; ${people.length} real people as targets`);

  const stamp = new Date().toISOString().slice(0, 16);
  const ids = await createItems(donId, `POOL-PROBE #50 ${stamp}`, 4 * n);
  const pair = (set: string[]) => set.map((id, i) => ({ id, person: people[i % people.length]! }));
  const [A, B, C, D] = [0, 1, 2, 3].map((k) => pair(ids.slice(k * n, (k + 1) * n))) as [ReturnType<typeof pair>, ReturnType<typeof pair>, ReturnType<typeof pair>, ReturnType<typeof pair>];
  await timed('link x1', 1, A.length, () => runPool(A, 1, async (p) => aliasedLinks(donId, donor, [p])));
  await timed('link x10', 1, B.length, () => runPool(groupsOf(B, 10), 1, (grp) => aliasedLinks(donId, donor, grp)));
  for (const set of [C, D]) await runPool(groupsOf(set, 10), 1, (grp) => aliasedLinks(donId, donor, grp)); // untimed
  await timed('arch x1', 1, C.length, () => runPool(C, 1, async (p) => aliasedArchives([p.id])));
  await timed('arch x10', 1, D.length, () => runPool(groupsOf(D.map((p) => p.id), 10), 1, aliasedArchives));
  // The unlinked, never-archived A and B are archived too, so no probe item stays visible.
  await runPool(groupsOf([...A, ...B].map((p) => p.id), 10), 1, aliasedArchives);
  if (out) writeFileSync(out, JSON.stringify({ n, rows }, null, 2));
}

async function main(): Promise<void> {
  const ws = await checkWorkspace();
  console.log(`workspace ${ws.id}: "${ws.name}" (${ws.kind})`);
  if (process.argv.includes('--check')) return;
  if (!process.argv.includes('--run')) throw new Error('probe: pass --check (read-only) or --run');
  if (!/sandbox/i.test(ws.name)) throw new Error(`probe: refusing to write — workspace "${ws.name}" is not named as a sandbox`);

  if (process.argv.includes('--real')) {
    return runReal(arg('--donations') ?? 'Donations (sandbox v3)', arg('--people') ?? 'People (sandbox v3)');
  }
  const onlyExtra = process.argv.includes('--only-extra');
  const linkConcs = onlyExtra ? [] : [1, 6, 12];
  const archiveConcs = onlyExtra ? [] : [1, 3, 12];
  const stamp = new Date().toISOString().slice(0, 16);
  const peopleBoard = await createBoard(`pool-probe people (scratch ${stamp})`);
  const donationsBoard = await createBoard(`pool-probe donations (scratch ${stamp})`);
  const extraBoards: string[] = [];
  try {
    const col = await client.gql<{ create_column: { id: string } }>(
      `mutation ($b: ID!, $d: JSON) { create_column (board_id: $b, title: "Donor", column_type: board_relation, defaults: $d) { id } }`,
      { b: donationsBoard, d: JSON.stringify({ boardIds: [Number(peopleBoard)] }) });
    const colId = col.create_column.id;
    const people = await createItems(peopleBoard, 'person', 20);
    const donations = await createItems(donationsBoard, 'gift', n * (linkConcs.length + archiveConcs.length) + (onlyExtra ? 2 * n : 0));
    console.log(`created ${people.length} people, ${donations.length} donations on scratch boards`);

    const link = async (itemId: string, i: number): Promise<void> => {
      await client.gql(
        `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!, $create: Boolean!) {
           change_multiple_column_values (board_id: $boardId, item_id: $itemId, column_values: $cols,
             create_labels_if_missing: $create) { id } }`,
        { boardId: donationsBoard, itemId, cols: JSON.stringify({ [colId]: { item_ids: [Number(people[i % people.length])] } }), create: true });
    };
    let at = 0;
    for (const c of linkConcs) {
      const set = donations.slice(at, at + n); at += n;
      await timed('link', c, set.length, () => runPool(set.map((id, i) => ({ id, i })), c, ({ id, i }) => link(id, i)));
    }
    for (const c of archiveConcs) {
      const set = donations.slice(at, at + n); at += n;
      await runPool(set.map((id, i) => ({ id, i })), 6, ({ id, i }) => link(id, i)); // linked first, as in the load; untimed
      await timed('archive', c, set.length, () => runPool(set, c, async (id) => {
        await client.gql('mutation ($id: ID!) { archive_item (item_id: $id) { id } }', { id });
      }));
    }
    if (onlyExtra) {
      // (1) Same total work spread over 4 boards, each with its own pool of 3.
      const boards = await Promise.all([1, 2, 3, 4].map(async (k) => {
        const board = await createBoard(`pool-probe donations ${k} (scratch ${stamp})`);
        extraBoards.push(board);
        const c = await client.gql<{ create_column: { id: string } }>(
          `mutation ($b: ID!, $d: JSON) { create_column (board_id: $b, title: "Donor", column_type: board_relation, defaults: $d) { id } }`,
          { b: board, d: JSON.stringify({ boardIds: [Number(peopleBoard)] }) });
        return { board, colId: c.create_column.id, items: await createItems(board, `gift${k}`, Math.floor(n / 2)) };
      }));
      for (const b of boards) {
        await runPool(b.items.map((id, i) => ({ id, i })), 6, ({ id, i }) => client.gql(
          `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) { change_multiple_column_values (board_id: $boardId, item_id: $itemId, column_values: $cols) { id } }`,
          { boardId: b.board, itemId: id, cols: JSON.stringify({ [b.colId]: { item_ids: [Number(people[i % people.length])] } }) }) as Promise<unknown> as Promise<void>);
      }
      await timed('arch-x4', 12, boards.length * boards[0]!.items.length, () => Promise.all(boards.map((b) =>
        runPool(b.items, 3, async (id) => {
          await client.gql('mutation ($id: ID!) { archive_item (item_id: $id) { id } }', { id });
        }))).then(() => undefined));

      // (2) Archives aliased 10 to a request on the main board, at pool sizes 1 and 3.
      const aliased = async (ids: string[]): Promise<void> => {
        const fields = ids.map((_, k) => `a${k}: archive_item (item_id: $i${k}) { id }`).join('\n');
        const vars = ids.map((_, k) => `$i${k}: ID!`).join(', ');
        const variables: Record<string, unknown> = {};
        ids.forEach((id, k) => { variables[`i${k}`] = id; });
        await client.gql(`mutation (${vars}) { ${fields} }`, variables);
      };
      let off = 0;
      for (const c of [1, 3]) {
        const set = donations.slice(off, off + n); off += n;
        await runPool(set.map((id, i) => ({ id, i })), 6, ({ id, i }) => link(id, i)); // linked first, untimed
        const groups: string[][] = [];
        for (let i = 0; i < set.length; i += 10) groups.push(set.slice(i, i + 10));
        await timed('arch-x10', c, set.length, () => runPool(groups, c, aliased));
      }
    }
  } finally {
    for (const b of [...extraBoards, donationsBoard, peopleBoard]) {
      await client.gql('mutation ($id: ID!) { archive_board (board_id: $id) { id } }', { id: b })
        .catch((e) => console.error(`probe: could not archive scratch board ${b}: ${e}`));
    }
    console.log(`scratch boards ${peopleBoard}, ${donationsBoard} archived (reversible)`);
    if (out) writeFileSync(out, JSON.stringify({ workspace: ws, n, rows }, null, 2));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
