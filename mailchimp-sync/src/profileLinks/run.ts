// The Mailchimp Profile link on People (spec 2026-11-18-mailchimp-journey-send-log-design.md): a 🔒
// link column opening each person's contact in Mailchimp, where newsletter sends, opens and clicks
// live. Runs on the hourly consent cron, from the same member read (each member's web_id).
// Optionally a second 🔒 Email Preferences link: the person's page on Mailchimp's hosted preferences
// form (each member's unique_email_id), which the Monday stewardship Sequences link to, so an
// opt-out from those emails lands in Mailchimp (docs/runbooks/stewardship-sequences.md).
// Stateless, like the consent sync: every run plans the whole board and writes only what differs.
//
// Never runs on a failed or short member read: an address missing from it would read as "not in
// Mailchimp" and clear its link.
import { runDisposition, type WriteMode } from '../flags';
import type { BatchSkipContext } from '../writeSwitch';
import type { ProfileLinksConfig } from '../types';
import type { GraphQLRequest } from '../consent/sources';

// preferencesUrl is '' when the preferences column is off.
export interface ProfileItem { itemId: string; email: string; url: string; preferencesUrl: string }
export type LinkKind = 'profile' | 'preferences';
export interface LinkWrite { itemId: string; kind: LinkKind; url: string | null }
// From the member read, by normalized address. Archived members have a web_id but no unique_email_id.
export interface MemberIds { webIds: ReadonlyMap<string, number>; uniqueEmailIds: ReadonlyMap<string, string> }

export interface ProfileLinksMonday {
  readBoard(settings: ProfileLinksConfig): Promise<ProfileItem[]>;
  writeLink(settings: ProfileLinksConfig, write: LinkWrite): Promise<void>;
}

export interface ProfileLinksDeps {
  settings: ProfileLinksConfig | null;
  monday: ProfileLinksMonday;
  // The member read's ids. Throws if the read failed.
  readMembers: () => Promise<MemberIds>;
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

export const LINK_TEXT: Record<LinkKind, string> = { profile: 'Mailchimp profile', preferences: 'Email preferences' };

// apiBaseUrl https://us9.api.mailchimp.com/3.0 → https://us9.admin.mailchimp.com
export function adminBaseUrl(apiBaseUrl: string): string {
  const host = new URL(apiBaseUrl).hostname.replace('.api.mailchimp.com', '.admin.mailchimp.com');
  return `https://${host}`;
}

export function profileUrl(adminBase: string, webId: number): string {
  return `${adminBase}/lists/members/view?id=${webId}`;
}

// pageUrl (validated in config.ts) has no e= yet.
export function preferencesUrl(pageUrl: string, uniqueEmailId: string): string {
  const url = new URL(pageUrl);
  url.searchParams.set('e', uniqueEmailId);
  return url.toString();
}

// pageUrl null: preferences off, so only profile links are planned.
export function planLinks(items: readonly ProfileItem[], members: MemberIds, adminBase: string, pageUrl: string | null): LinkWrite[] {
  const writes: LinkWrite[] = [];
  for (const item of items) {
    const address = item.email.trim().toLowerCase();
    const webId = members.webIds.get(address);
    const want = webId === undefined ? null : profileUrl(adminBase, webId);
    if ((want ?? '') !== item.url) writes.push({ itemId: item.itemId, kind: 'profile', url: want });
    if (pageUrl === null) continue;
    const uniqueEmailId = members.uniqueEmailIds.get(address);
    const wantPrefs = uniqueEmailId === undefined ? null : preferencesUrl(pageUrl, uniqueEmailId);
    if ((wantPrefs ?? '') !== item.preferencesUrl) writes.push({ itemId: item.itemId, kind: 'preferences', url: wantPrefs });
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

  let members: MemberIds;
  try {
    members = await deps.readMembers();
  } catch {
    // The consent run already logged and alerted on this read.
    return { ...summary, outcome: 'read-failed' };
  }
  const items = await deps.monday.readBoard(settings);
  const writes = planLinks(items, members, deps.adminBaseUrl, settings.preferences?.pageUrl ?? null);
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
      console.error(JSON.stringify({ worker: 'mailchimp-sync', event: 'profile-link-failed', environment: gate.environment, itemId: write.itemId, kind: write.kind, error: errName(err) }));
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
      const prefsColumn = settings.preferences?.column;
      const columnIds = [settings.emailColumn, settings.linkColumn, ...(prefsColumn === undefined ? [] : [prefsColumn])];
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
          items.push({
            itemId: item.id,
            email: (email.email || email.text || '').trim(),
            url: (byId.get(settings.linkColumn)!.url ?? '').trim(),
            preferencesUrl: prefsColumn === undefined ? '' : (byId.get(prefsColumn)!.url ?? '').trim(),
          });
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
      const value = write.url === null ? {} : { url: write.url, text: LINK_TEXT[write.kind] };
      const columnId = write.kind === 'profile' ? settings.linkColumn : settings.preferences?.column;
      if (columnId === undefined) throw new Error('profile links: a preferences write with preferences off');
      await request(
        `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
          change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
        }`,
        { boardId: settings.boardId, itemId: write.itemId, columnId, value: JSON.stringify(value) },
      );
    },
  };
}
