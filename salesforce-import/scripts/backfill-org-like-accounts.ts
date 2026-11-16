// One-off: adds the Organizations items for config `organizationAccountSfIds` (One-to-One Accounts
// that are really organizations) and the Affiliations items that point at them, on a board set that
// was loaded before the transform handled them. Their affiliations — and roles — were dropped.
// Doesn't use `load`: that needs the ledger of the load being repaired, and without it would
// recreate everything. Items are matched by their Salesforce ID column instead, so re-running is safe.
//
// Prerequisites: run `npm run cli -- transform` with the current config against the extract the
// board set was loaded from (it writes data/transform/payloads.ndjson), and use a token that can
// see all four boards (the production donor boards are private).
//
//   # dry run (default): resolves everything, prints the plan, writes nothing
//   MONDAY_API_TOKEN=... tsx scripts/backfill-org-like-accounts.ts \
//     --organizations 111 --affiliations 222 --people-live 333 --people-historical 444
//   # applies; --expect is the dry run's "items to create" count, so a board that moved since is refused
//   MONDAY_API_TOKEN=... tsx scripts/backfill-org-like-accounts.ts <same boards> --apply --expect 35
//
// Writes, in order: create missing Organizations, create missing Affiliations (with the payload's
// columns), then connect columns — each Affiliation's Person and Organization, and the Person's
// Affiliations (and Organization, for a Current tenure), merged with what's already linked.
// If a create's outcome is unknown the run stops; the next dry run finds what landed.
// Afterwards: archive the pseudo-org People items (their Contacts only restated the Account name).
import { MondayClient, AmbiguousWriteError } from '../src/load/monday.js';
import { COLUMN_TYPES } from '../src/load/boards.js';
import { formatColumnValue } from '../src/load/columnValues.js';
import { SF_ID_COLUMN, findItemIdsBySfIds } from '../src/load/lookup.js';
import { loadConfig } from '../src/config.js';
import { dataPath, readNdjson } from '../src/artifacts.js';
import type { ItemPayload } from '../src/transform/types.js';
import { planBackfill, mergeLinkedIds, type PersonRef } from '../src/repair/orgLikeBackfill.js';
import { bareTitle } from '../../scripts/lib/column-titles.mjs';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const need = (name: string): number => {
  const v = arg(name);
  if (!v || !/^\d+$/.test(v)) throw new Error(`${name} <board id> is required`);
  return Number(v);
};
const apply = process.argv.includes('--apply');
const expected = arg('--expect');
if (!process.env.MONDAY_API_TOKEN) throw new Error('MONDAY_API_TOKEN is not set');
if (apply && expected === undefined) throw new Error('--apply needs --expect <count from the dry run>');
const BOARDS = {
  organizations: need('--organizations'), affiliations: need('--affiliations'),
  'people-live': need('--people-live'), 'people-historical': need('--people-historical'),
} as const;
type BoardKey = keyof typeof BOARDS;

const client = new MondayClient({ apiUrl: 'https://api.monday.com/v2', token: process.env.MONDAY_API_TOKEN });

// ---- Boards: confirm each is visible and resolve column ids by bare title ----------------------
const columnIds = new Map<BoardKey, Record<string, string>>();
for (const key of Object.keys(BOARDS) as BoardKey[]) {
  const { boards } = await client.gql<{ boards: { name: string; columns: { id: string; title: string }[] }[] }>(
    'query ($b: [ID!]) { boards(ids: $b) { name columns { id title } } }', { b: [String(BOARDS[key])] });
  const board = boards[0];
  if (!board) throw new Error(`board ${BOARDS[key]} (${key}) is not visible to this token`);
  columnIds.set(key, Object.fromEntries(board.columns.map((c) => [bareTitle(c.title), c.id])));
  console.log(`${key}: "${board.name}" (${BOARDS[key]})`);
  if (!columnIds.get(key)![SF_ID_COLUMN]) throw new Error(`board ${BOARDS[key]} (${key}) has no "${SF_ID_COLUMN}" column`);
}
const col = (key: BoardKey, title: string): string => {
  const id = columnIds.get(key)![title];
  if (!id) throw new Error(`board ${BOARDS[key]} (${key}) has no "${title}" column`);
  return id;
};

// ---- Plan ---------------------------------------------------------------------------------------
const cfg = loadConfig();
const orgSfIds = new Set(cfg.organizationAccountSfIds ?? []);
if (orgSfIds.size === 0) throw new Error('config has no organizationAccountSfIds');
const payloads = await readNdjson<ItemPayload>(dataPath('transform', 'payloads.ndjson'));

const candidateAffs = payloads.filter((p) => p.board === 'affiliations' &&
  p.links?.some((l) => l.column === 'Organization' && l.targetSfIds.some((t) => orgSfIds.has(t))));
const personSfIds = [...new Set(candidateAffs.flatMap((p) => p.links!.filter((l) => l.column === 'Person').flatMap((l) => l.targetSfIds)))];

const lookup = (key: BoardKey, sfIds: string[]) => findItemIdsBySfIds(client, BOARDS[key], col(key, SF_ID_COLUMN), sfIds);
const people = new Map<string, PersonRef>();
for (const key of ['people-live', 'people-historical'] as const) {
  for (const [sfId, ids] of await lookup(key, personSfIds)) if (!people.has(sfId)) people.set(sfId, { id: ids[0]!, board: key });
}
const plan = planBackfill({
  orgSfIds, payloads,
  existingOrgs: await lookup('organizations', [...orgSfIds]),
  existingAffiliations: await lookup('affiliations', candidateAffs.map((p) => p.sfId)),
  people,
});

const orgsToCreate = plan.orgs.filter((o) => !o.existingItemId);
const affsToCreate = plan.affiliations.filter((a) => !a.existingItemId);
console.log(`\nOrganizations: ${plan.orgs.length} configured, ${orgsToCreate.length} to create, ${plan.orgs.length - orgsToCreate.length} already on the board`);
for (const o of orgsToCreate) console.log(`  + ${o.payload.name}  (${o.payload.sfId})`);
console.log(`Affiliations: ${plan.affiliations.length} point at them, ${affsToCreate.length} to create, ${plan.affiliations.length - affsToCreate.length} already on the board`);
for (const a of affsToCreate) console.log(`  + ${a.payload.name}  role: ${JSON.stringify(a.payload.columns['Affiliation Role'] ?? '')}  (${a.payload.sfId})`);
for (const s of plan.skipped) console.log(`  skipped ${s.sfId}: ${s.reason}`);
for (const d of plan.duplicates) console.log(`  DUPLICATE on ${d.board}: ${d.sfId} -> items ${d.itemIds.join(', ')} (using the first; clean up by hand)`);

// Names the boards already hold under another Salesforce ID (staff may have made these by hand).
for (const o of orgsToCreate) {
  const r = await client.gql<{ items_page_by_column_values: { items: { id: string }[] } }>(
    `query ($b: ID!, $n: String!) { items_page_by_column_values(board_id: $b, limit: 5,
       columns: [{ column_id: "name", column_values: [$n] }]) { items { id } } }`,
    { b: String(BOARDS.organizations), n: o.payload.name }).catch(() => null);
  const clash = r?.items_page_by_column_values.items ?? [];
  if (clash.length > 0) console.log(`  WARNING: an Organizations item named "${o.payload.name}" already exists (${clash.map((i) => i.id).join(', ')}) — apply would add a second one`);
}

// Fail the dry run, not the apply, when a payload needs a column the board lacks.
const colValues = (key: BoardKey, p: ItemPayload): Record<string, unknown> => {
  const out: Record<string, unknown> = { [col(key, SF_ID_COLUMN)]: p.sfId };
  for (const [title, value] of Object.entries(p.columns)) {
    if (value === null || value === undefined || value === '') continue;
    const formatted = formatColumnValue(COLUMN_TYPES[title] ?? 'text', value);
    if (formatted !== null) out[col(key, title)] = formatted;
  }
  return out;
};
for (const o of orgsToCreate) colValues('organizations', o.payload);
for (const a of affsToCreate) colValues('affiliations', a.payload);
for (const key of ['people-live', 'people-historical'] as const) { col(key, 'Affiliations'); col(key, 'Organization'); }
col('affiliations', 'Person'); col('affiliations', 'Organization');

const toCreate = orgsToCreate.length + affsToCreate.length;
console.log(`\nItems to create: ${toCreate}`);
if (!apply) {
  console.log('Dry run: nothing written.');
  process.exit(0);
}
if (String(toCreate) !== expected) throw new Error(`--expect ${expected}, but ${toCreate} items would be created now; re-run the dry run`);
if (plan.duplicates.length > 0) throw new Error('duplicates on the boards; resolve them first');

// ---- Apply --------------------------------------------------------------------------------------
const create = async (key: BoardKey, p: ItemPayload): Promise<string> => {
  try {
    const res = await client.gql<{ create_item: { id: string } }>(
      `mutation ($boardId: ID!, $itemName: String!, $cols: JSON) {
         create_item (board_id: $boardId, item_name: $itemName, column_values: $cols) { id } }`,
      { boardId: String(BOARDS[key]), itemName: p.name, cols: JSON.stringify(colValues(key, p)) }, { idempotent: false });
    return res.create_item.id;
  } catch (err) {
    if (err instanceof AmbiguousWriteError) {
      throw new Error(`create of ${p.sfId} on ${key} may or may not have landed; stopping. Re-run the dry run: it matches by Salesforce ID and shows what is left. (${err.message})`);
    }
    throw err;
  }
};
const setLinks = (key: BoardKey, itemId: string, links: Record<string, string[]>) => client.gql(
  `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
     change_multiple_column_values (board_id: $boardId, item_id: $itemId, column_values: $cols) { id } }`,
  { boardId: String(BOARDS[key]), itemId, cols: JSON.stringify(Object.fromEntries(
    Object.entries(links).map(([c, ids]) => [c, { item_ids: ids.map(Number) }]))) });

const orgItemId = new Map<string, string>();
for (const o of plan.orgs) {
  const id = o.existingItemId ?? await create('organizations', o.payload);
  orgItemId.set(o.payload.sfId, id);
  if (!o.existingItemId) console.log(`created Organization ${o.payload.name} -> ${id}`);
}
const affItemId = new Map<string, string>();
for (const a of plan.affiliations) {
  const id = a.existingItemId ?? await create('affiliations', a.payload);
  affItemId.set(a.payload.sfId, id);
  if (!a.existingItemId) console.log(`created Affiliation ${a.payload.name} -> ${id}`);
}

// Affiliation side: replace-style write is fine — these items hold only this backfill's links.
for (const a of plan.affiliations) {
  await setLinks('affiliations', affItemId.get(a.payload.sfId)!, {
    [col('affiliations', 'Person')]: [a.person.id], [col('affiliations', 'Organization')]: [orgItemId.get(a.orgSfId)!] });
}

// Person side: merge into whatever the Person already links, never overwrite.
type RelationValue = { id: string; linked_item_ids?: string[] };
const byPerson = new Map<string, { person: PersonRef; affs: string[]; orgs: string[] }>();
for (const a of plan.affiliations) {
  const entry = byPerson.get(a.person.id) ?? { person: a.person, affs: [], orgs: [] };
  entry.affs.push(affItemId.get(a.payload.sfId)!);
  if (a.current) entry.orgs.push(orgItemId.get(a.orgSfId)!);
  byPerson.set(a.person.id, entry);
}
let personWrites = 0;
for (const [personId, { person, affs, orgs }] of byPerson) {
  const affCol = col(person.board, 'Affiliations'), orgCol = col(person.board, 'Organization');
  const { items } = await client.gql<{ items: { column_values: (RelationValue)[] }[] }>(
    `query ($i: [ID!], $c: [String!]) { items(ids: $i) { column_values(ids: $c) {
       id ... on BoardRelationValue { linked_item_ids } } } }`, { i: [personId], c: [affCol, orgCol] });
  const current = (c: string) => items[0]?.column_values.find((v) => v.id === c)?.linked_item_ids ?? [];
  const next: Record<string, string[]> = {};
  const mergedAffs = mergeLinkedIds(current(affCol), affs);
  const mergedOrgs = mergeLinkedIds(current(orgCol), orgs);
  if (mergedAffs) next[affCol] = mergedAffs;
  if (mergedOrgs) next[orgCol] = mergedOrgs;
  if (Object.keys(next).length === 0) continue;
  await setLinks(person.board, personId, next);
  personWrites++;
}
console.log(`\nDone: ${orgsToCreate.length} Organizations and ${affsToCreate.length} Affiliations created; `
  + `${plan.affiliations.length} affiliations linked; ${personWrites} Persons updated.`);
console.log('Next: archive the pseudo-org People items, then re-run the dry run — it should report 0 to create.');
