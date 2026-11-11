import { existsSync } from 'node:fs';
import { registerCommand } from '../commands.js';
import { loadConfig } from '../config.js';
import { appendNdjson, dataPath, readNdjson, repairTornTail } from '../artifacts.js';
import { runSoqlPaginated, type ExecFn } from '../extract/sfdx.js';
import { MondayClient } from '../load/monday.js';
import { SF_ID_COLUMN, scanBoardSfIds } from '../load/lookup.js';
import { isOneToOneAccount } from '../transform/people.js';

// Salesforce Organizations used Account.Description like People use Emails & Activities: a
// running log of calls, meetings and context. The main import never carried it, so this
// backfills each one as an entry on the organization's Emails & Activities timeline.
//
// Monday's public API has no plain "Note" mutation, only create_timeline_item, which needs a
// custom activity type (created once in the Monday UI — there is no API for that). Staff create
// a "Salesforce note" custom activity and pass its id as --activity-id.

export interface OrgNote {
  sfId: string; name: string; description: string; lastModified: string;
}

interface TimelineClient {
  gql<T>(query: string, variables?: Record<string, unknown>, opts?: { idempotent?: boolean }): Promise<T>;
}

type LedgerRow = { sfId: string; itemId: string; timelineItemId: string } | { sfId: string; error: string };

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Plain-text Description to the HTML Monday renders: paragraphs on blank lines, <br> on newlines. */
export function descriptionToHtml(text: string): string {
  return text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

const summaryOf = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
};

/** Every non-person Account with a non-blank Description. */
export async function fetchOrgNotes(org: string, exec?: ExecFn): Promise<{ notes: OrgNote[]; skippedPersons: number }> {
  const rows = await runSoqlPaginated(org,
    'SELECT Id, Name, Description, npe01__SYSTEM_AccountType__c, LastModifiedDate FROM Account', { exec });
  const notes: OrgNote[] = [];
  let skippedPersons = 0;
  for (const r of rows) {
    const description = String(r['Description'] ?? '').trim();
    if (!description) continue;
    // One-to-One Accounts are People; their Description is a Contact-side question, not this one.
    if (isOneToOneAccount(r)) { skippedPersons++; continue; }
    notes.push({ sfId: r['Id'] as string, name: String(r['Name'] ?? ''), description,
      lastModified: new Date(String(r['LastModifiedDate'])).toISOString() });
  }
  return { notes, skippedPersons };
}

export async function runBackfillOrgNotes(args: string[],
  deps: { exec?: ExecFn; client?: TimelineClient } = {}): Promise<number> {
  const cfg = loadConfig();
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dryRun = args.includes('--dry-run');
  const boardId = Number(flag('--board') ?? cfg.monday.boards['organizations']);
  const activityId = flag('--activity-id');
  if (!dryRun && (!activityId || activityId.startsWith('--'))) {
    console.error('backfill-org-notes: --activity-id <custom activity id> is required (create a ' +
      '"Salesforce note" custom activity in Monday first; see README)');
    return 2;
  }
  if (!Number.isInteger(boardId) || boardId <= 0) {
    console.error('backfill-org-notes: pass --board <Organizations board id> (config has none)');
    return 2;
  }

  const { notes, skippedPersons } = await fetchOrgNotes(cfg.salesforceOrg, deps.exec);
  console.log(`backfill-org-notes: ${notes.length} organization Descriptions` +
    (skippedPersons ? ` (${skippedPersons} on One-to-One person Accounts skipped)` : ''));

  const ledgerPath = dataPath('backfill', 'org-notes.ndjson');
  const done = new Set<string>();
  if (existsSync(ledgerPath)) {
    await repairTornTail(ledgerPath);
    for (const r of await readNdjson<LedgerRow>(ledgerPath)) if ('timelineItemId' in r) done.add(r.sfId);
  }
  const todo = notes.filter((n) => !done.has(n.sfId));
  console.log(`backfill-org-notes: ${done.size} already written, ${todo.length} to do`);
  if (dryRun) {
    for (const n of todo.slice(0, 5)) console.log(`  ${n.sfId} ${n.name}: ${summaryOf(n.description)}`);
    return 0;
  }

  let client = deps.client;
  if (!client) {
    const token = process.env['MONDAY_API_TOKEN'];
    if (!token) { console.error('backfill-org-notes: MONDAY_API_TOKEN not set'); return 1; }
    client = new MondayClient({ apiUrl: cfg.monday.apiUrl, token });
  }

  // The Salesforce ID column's id, then every item carrying one of the Ids.
  const cols = await client.gql<{ boards: { columns: { id: string; title: string }[] }[] }>(
    'query ($ids: [ID!]) { boards (ids: $ids) { columns { id title } } }', { ids: [String(boardId)] });
  const sfCol = cols.boards[0]?.columns.find((c) => c.title === SF_ID_COLUMN)?.id;
  if (!sfCol) { console.error(`backfill-org-notes: board ${boardId} has no "${SF_ID_COLUMN}" column`); return 1; }
  const { bySfId } = await scanBoardSfIds(client as MondayClient, boardId, sfCol);

  let written = 0, missing = 0, ambiguous = 0, failed = 0;
  for (const n of todo) {
    const items = bySfId.get(n.sfId);
    if (!items?.length) { missing++; continue; }
    if (items.length > 1) { ambiguous++; console.warn(`backfill-org-notes: ${n.sfId} (${n.name}) is on ${items.length} items; skipped`); continue; }
    try {
      // Not idempotent and an entry can't be looked up, so a failure is ledgered, never retried.
      const res = await client.gql<{ create_timeline_item: { id: string } }>(
        `mutation ($itemId: ID!, $activityId: String!, $title: String!, $summary: String, $content: String, $timestamp: ISO8601DateTime!) {
           create_timeline_item (item_id: $itemId, custom_activity_id: $activityId, title: $title,
             summary: $summary, content: $content, timestamp: $timestamp) { id } }`,
        { itemId: items[0]!, activityId, title: 'Salesforce description', summary: summaryOf(n.description),
          content: descriptionToHtml(n.description), timestamp: n.lastModified },
        { idempotent: false });
      await appendNdjson(ledgerPath, { sfId: n.sfId, itemId: items[0]!, timelineItemId: res.create_timeline_item.id });
      written++;
    } catch (err) {
      failed++;
      await appendNdjson(ledgerPath, { sfId: n.sfId, error: String(err) });
      console.error(`backfill-org-notes: FAILED ${n.sfId} (${n.name}): ${String(err)}`);
    }
  }
  console.log(`backfill-org-notes: wrote ${written}; no Organizations item for ${missing}; ` +
    `duplicate items ${ambiguous}; failed ${failed}`);
  return failed > 0 ? 1 : 0;
}

registerCommand('backfill-org-notes', (args) => runBackfillOrgNotes(args));
