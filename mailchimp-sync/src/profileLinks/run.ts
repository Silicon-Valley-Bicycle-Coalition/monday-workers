// The Mailchimp Profile link on People (spec 2026-11-18-mailchimp-journey-send-log-design.md): a 🔒
// link column opening each person's contact in Mailchimp, where newsletter sends, opens and clicks
// live. Runs on the hourly consent cron, from the same member read (each member's web_id).
// Stateless, like the consent sync: every run plans the whole board and writes only what differs.
//
// Never runs on a failed or short member read: an address missing from it would read as "not in
// Mailchimp" and clear its link.
import { runDisposition, type WriteMode } from '../flags';
import type { BatchSkipContext } from '../writeSwitch';
import type { ProfileLinksConfig } from '../types';
import type { GraphQLRequest } from '../consent/sources';

export interface ProfileItem { itemId: string; email: string; url: string }
export interface LinkWrite { itemId: string; url: string | null }

export interface ProfileLinksMonday {
  readBoard(settings: ProfileLinksConfig): Promise<ProfileItem[]>;
  writeLink(settings: ProfileLinksConfig, write: LinkWrite): Promise<void>;
}

export interface ProfileLinksDeps {
  settings: ProfileLinksConfig | null;
  monday: ProfileLinksMonday;
  // The member read's address → web_id. Throws if the read failed.
  readWebIds: () => Promise<Map<string, number>>;
  // e.g. https://us9.admin.mailchimp.com
  adminBaseUrl: string;
  isOutage: (err: unknown) => boolean;
  // Stops writing at this time (ms), so the cron ends on its own terms.
  deadline: number;
  now?: () => number;
}

export interface ProfileLinksSummary {
  outcome: 'disabled' | 'skipped' | 'read-failed' | 'done';
  mode: WriteMode;
  items: number;
  planned: number;
  written: number;
  cleared: number;
  failed: number;
  deferred: number;
}

export const LINK_TEXT = 'Mailchimp profile';

// apiBaseUrl https://us9.api.mailchimp.com/3.0 → https://us9.admin.mailchimp.com
export function adminBaseUrl(apiBaseUrl: string): string {
  const host = new URL(apiBaseUrl).hostname.replace('.api.mailchimp.com', '.admin.mailchimp.com');
  return `https://${host}`;
}

export function profileUrl(adminBase: string, webId: number): string {
  return `${adminBase}/lists/members/view?id=${webId}`;
}

export function planLinks(items: readonly ProfileItem[], webIds: ReadonlyMap<string, number>, adminBase: string): LinkWrite[] {
  const writes: LinkWrite[] = [];
  for (const item of items) {
    const webId = webIds.get(item.email.trim().toLowerCase());
    const want = webId === undefined ? null : profileUrl(adminBase, webId);
    if ((want ?? '') !== item.url) writes.push({ itemId: item.itemId, url: want });
  }
  return writes;
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : 'UnknownError');

export async function runProfileLinks(gate: BatchSkipContext, deps: ProfileLinksDeps): Promise<ProfileLinksSummary> {
  const { settings } = deps;
  const now = deps.now ?? Date.now;
  const summary: ProfileLinksSummary = { outcome: 'done', mode: gate.mode, items: 0, planned: 0, written: 0, cleared: 0, failed: 0, deferred: 0 };
  if (settings === null) return { ...summary, outcome: 'disabled' };
  const disposition = runDisposition(gate.mode);
  if (disposition === 'skip') return { ...summary, outcome: 'skipped' };

  let webIds: Map<string, number>;
  try {
    webIds = await deps.readWebIds();
  } catch {
    // The consent run already logged and alerted on this read.
    return { ...summary, outcome: 'read-failed' };
  }
  const items = await deps.monday.readBoard(settings);
  const writes = planLinks(items, webIds, deps.adminBaseUrl);
  summary.items = items.length;
  summary.planned = writes.length;

  if (disposition === 'dry-run') {
    console.log(JSON.stringify({ worker: 'mailchimp-sync', event: 'profile-links-run', environment: gate.environment, dryRun: true, ...summary }));
    return summary;
  }
  const work = writes.slice(0, settings.maxWritesPerRun);
  summary.deferred = writes.length - work.length;
  for (let i = 0; i < work.length; i += 1) {
    if (now() >= deps.deadline) {
      summary.deferred += work.length - i;
      break;
    }
    const write = work[i]!;
    try {
      await deps.monday.writeLink(settings, write);
      if (write.url === null) summary.cleared += 1;
      else summary.written += 1;
    } catch (err) {
      if (deps.isOutage(err)) {
        summary.deferred += work.length - i;
        break;
      }
      summary.failed += 1;
      console.error(JSON.stringify({ worker: 'mailchimp-sync', event: 'profile-link-failed', environment: gate.environment, itemId: write.itemId, error: errName(err) }));
    }
  }
  console.log(JSON.stringify({ worker: 'mailchimp-sync', event: 'profile-links-run', environment: gate.environment, ...summary }));
  return summary;
}

const PAGE = 500;
const ITEM_FIELDS = 'cursor items { id column_values(ids: $columnIds) { id text ... on EmailValue { email } ... on LinkValue { url } } }';
interface ItemsPage { cursor: string | null; items: { id: string; column_values: { id: string; text: string | null; email?: string | null; url?: string | null }[] }[] }

export function createProfileLinksMonday(request: GraphQLRequest): ProfileLinksMonday {
  return {
    async readBoard(settings) {
      const columnIds = [settings.emailColumn, settings.linkColumn];
      const first = await request<{ boards: { items_page: ItemsPage }[] }>(
        `query ($boardId: ID!, $columnIds: [String!]) { boards(ids: [$boardId]) { items_page(limit: ${PAGE}) { ${ITEM_FIELDS} } } }`,
        { boardId: settings.boardId, columnIds },
      );
      const firstPage = first.boards?.[0]?.items_page;
      if (firstPage === undefined) throw new Error(`profile links: board ${settings.boardId} is not readable`);
      let page: ItemsPage = firstPage;
      const items: ProfileItem[] = [];
      for (;;) {
        for (const item of page.items) {
          const byId = new Map(item.column_values.map((cv) => [cv.id, cv]));
          // A mistyped config id comes back as no column value at all.
          for (const id of columnIds) if (!byId.has(id)) throw new Error(`profile links: board ${settings.boardId} has no column "${id}"`);
          const email = byId.get(settings.emailColumn)!;
          items.push({ itemId: item.id, email: (email.email || email.text || '').trim(), url: (byId.get(settings.linkColumn)!.url ?? '').trim() });
        }
        if (page.cursor === null) break;
        const next: { next_items_page: ItemsPage } = await request<{ next_items_page: ItemsPage }>(
          `query ($cursor: String!, $columnIds: [String!]) { next_items_page(limit: ${PAGE}, cursor: $cursor) { ${ITEM_FIELDS} } }`,
          { cursor: page.cursor, columnIds },
        );
        page = next.next_items_page;
      }
      return items;
    },

    async writeLink(settings, write) {
      // An empty object clears a link column.
      const value = write.url === null ? {} : { url: write.url, text: LINK_TEXT };
      await request(
        `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
          change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
        }`,
        { boardId: settings.boardId, itemId: write.itemId, columnId: settings.linkColumn, value: JSON.stringify(value) },
      );
    },
  };
}
