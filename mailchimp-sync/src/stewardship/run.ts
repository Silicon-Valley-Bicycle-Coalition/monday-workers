// Daily run of the stewardship labels (plan.ts), on the daily cron after the renewal-due tag.
// Reads People, plans, checks each planned send against Mailchimp (the consent system of record),
// and sets the 🔒 Stewardship Email label that a Monday automation turns into a Sequence
// enrollment. Stateless apart from the label itself, which the plan reads back next day.
//
// Follows the write switch like the other crons: `hold`/`unknown` skip the day, `off` plans and
// logs without writing. Logs carry counts and item ids only, never an address.
import { runDisposition, type WriteMode } from '../flags';
import type { BatchSkipContext } from '../writeSwitch';
import type { StewardshipConfig } from '../types';
import type { GraphQLRequest } from '../consent/sources';
import { memberId } from '../logSafe';
import { todayIn } from '../renewalDue/plan';
import { planStewardship, type StewardshipPerson, type StewardshipWrite } from './plan';

const TIME_ZONE = 'America/Los_Angeles';
const REQUEST_TIMEOUT_MS = 20_000;

export interface StewardshipMonday {
  readPeople(settings: StewardshipConfig): Promise<StewardshipPerson[]>;
  writeLabel(settings: StewardshipConfig, write: StewardshipWrite): Promise<void>;
}

// One Mailchimp member, or null when the address isn't in the audience.
export interface MailchimpMember {
  status: string;
  tags: string[];
  interests: Record<string, boolean>;
}

export interface StewardshipDeps {
  settings: StewardshipConfig | null;
  monday: StewardshipMonday;
  readMember: (email: string) => Promise<MailchimpMember | null>;
  isOutage: (err: unknown) => boolean;
  now?: () => Date;
}

export interface StewardshipSummary {
  outcome: 'disabled' | 'skipped' | 'read-failed' | 'done';
  mode: WriteMode;
  people: number;
  planned: number;
  // Due an email but with no gift on record, so left out of `planned`.
  skippedNoGift: number;
  welcome: number;
  renewal: number;
  cleared: number;
  optedOut: number;
  failed: number;
  deferred: number;
  dryRun: boolean;
}

export type SendCheck = 'send' | 'not-in-mailchimp' | 'not-subscribed' | 'renewal-opt-out' | 'unticked';

/** Whether Mailchimp lets this person get this email. A missing member is never sent to. */
export function checkMember(member: MailchimpMember | null, write: StewardshipWrite, settings: StewardshipConfig): SendCheck {
  if (member === null) return 'not-in-mailchimp';
  if (member.status !== 'subscribed') return 'not-subscribed';
  if (write.kind === 'renewal' && member.tags.includes(settings.renewalOptOutTag)) return 'renewal-opt-out';
  const interest = write.kind === 'renewal' ? settings.renewalInterest : settings.welcomeInterest;
  if (interest !== null && member.interests[interest] !== true) return 'unticked';
  return 'send';
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : 'UnknownError');

export async function runStewardship(gate: BatchSkipContext, deps: StewardshipDeps): Promise<StewardshipSummary> {
  const { settings } = deps;
  const summary: StewardshipSummary = {
    outcome: 'done', mode: gate.mode, people: 0, planned: 0, skippedNoGift: 0, welcome: 0, renewal: 0, cleared: 0, optedOut: 0, failed: 0, deferred: 0, dryRun: false,
  };
  const log = (event: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ worker: 'mailchimp-sync', event, environment: gate.environment, ...extra }));
  if (settings === null) return { ...summary, outcome: 'disabled' };
  const disposition = runDisposition(gate.mode);
  if (disposition === 'skip') {
    console.warn(`mailchimp-sync stewardship (${gate.environment}): write mode is "${gate.mode}"; skipping today's run`);
    return { ...summary, outcome: 'skipped' };
  }

  let people: StewardshipPerson[];
  try {
    people = await deps.monday.readPeople(settings);
  } catch (err) {
    console.error(`mailchimp-sync stewardship (${gate.environment}): the People read failed; nothing written today: ${errName(err)}`);
    return { ...summary, outcome: 'read-failed' };
  }
  const today = todayIn(TIME_ZONE, (deps.now ?? (() => new Date()))());
  const { writes, skippedNoGift } = planStewardship(people, { today, ...settings.plan });
  summary.people = people.length;
  summary.planned = writes.length;
  summary.skippedNoGift = skippedNoGift;
  summary.dryRun = disposition === 'dry-run';

  const work = writes.slice(0, settings.maxWritesPerRun);
  summary.deferred = writes.length - work.length;
  for (let i = 0; i < work.length; i += 1) {
    const write = work[i]!;
    try {
      if (write.kind !== 'clear') {
        const check = checkMember(await deps.readMember(write.email), write, settings);
        if (check !== 'send') {
          summary.optedOut += 1;
          log('stewardship-not-sent', { itemId: write.itemId, label: write.label, reason: check });
          continue;
        }
      }
      if (!summary.dryRun) await deps.monday.writeLabel(settings, write);
      if (write.kind === 'clear') summary.cleared += 1;
      else summary[write.kind] += 1;
      log(summary.dryRun ? 'stewardship-would-set' : 'stewardship-set', { itemId: write.itemId, label: write.label });
    } catch (err) {
      if (deps.isOutage(err)) {
        summary.deferred += work.length - i;
        break;
      }
      summary.failed += 1;
      console.error(JSON.stringify({ worker: 'mailchimp-sync', event: 'stewardship-failed', environment: gate.environment, itemId: write.itemId, error: errName(err) }));
    }
  }
  log('stewardship-run', { today, ...summary });
  return summary;
}

export interface MailchimpReadOptions {
  fetchFn: typeof fetch;
  apiBaseUrl: string;
  apiKey: string;
  audienceId: string;
}

export function createMemberReader(opts: MailchimpReadOptions): (email: string) => Promise<MailchimpMember | null> {
  const auth = `Basic ${btoa(`anystring:${opts.apiKey}`)}`;
  return async (email) => {
    const params = new URLSearchParams({ fields: 'status,tags,interests' });
    const res = await opts.fetchFn(`${opts.apiBaseUrl}/lists/${opts.audienceId}/members/${memberId(email)}?${params}`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`read member ${memberId(email)}: HTTP ${res.status}`);
    const body = (await res.json()) as { status: string; tags?: { name: string }[]; interests?: Record<string, boolean> };
    return { status: body.status, tags: (body.tags ?? []).map((t) => t.name), interests: body.interests ?? {} };
  };
}

const PAGE = 500;
const ITEM_FIELDS = 'cursor items { id column_values(ids: $columnIds) { id text ... on EmailValue { email } } }';
interface ItemsPage { cursor: string | null; items: { id: string; column_values: { id: string; text: string | null; email?: string | null }[] }[] }

export function createStewardshipMonday(request: GraphQLRequest): StewardshipMonday {
  return {
    async readPeople(settings) {
      const c = settings.columns;
      const columnIds = [c.email, c.label, c.membershipStatus, c.membershipTier, c.memberType, c.memberSince, c.memberUntil, c.hasActiveRecurringGift, c.doNotSolicit, c.lastGiftAmount];
      const first = await request<{ boards: { items_page: ItemsPage }[] }>(
        `query ($boardId: ID!, $columnIds: [String!]) { boards(ids: [$boardId]) { items_page(limit: ${PAGE}) { ${ITEM_FIELDS} } } }`,
        { boardId: settings.boardId, columnIds },
      );
      const firstPage = first.boards?.[0]?.items_page;
      if (firstPage === undefined) throw new Error(`stewardship: board ${settings.boardId} is not readable`);
      let page: ItemsPage = firstPage;
      const people: StewardshipPerson[] = [];
      for (;;) {
        for (const item of page.items) {
          const byId = new Map(item.column_values.map((cv) => [cv.id, cv]));
          // A mistyped config id comes back as no column value at all.
          for (const id of columnIds) if (!byId.has(id)) throw new Error(`stewardship: board ${settings.boardId} has no column "${id}"`);
          const text = (id: string) => (byId.get(id)!.text ?? '').trim();
          people.push({
            itemId: item.id,
            email: (byId.get(c.email)!.email || text(c.email)).trim(),
            label: text(c.label),
            membershipStatus: text(c.membershipStatus),
            membershipTier: text(c.membershipTier),
            memberType: text(c.memberType),
            memberSince: text(c.memberSince),
            memberUntil: text(c.memberUntil),
            hasActiveRecurringGift: text(c.hasActiveRecurringGift) !== '',
            doNotSolicit: text(c.doNotSolicit) !== '',
            lastGiftAmount: text(c.lastGiftAmount),
          });
        }
        if (page.cursor === null) break;
        const next: { next_items_page: ItemsPage } = await request<{ next_items_page: ItemsPage }>(
          `query ($cursor: String!, $columnIds: [String!]) { next_items_page(limit: ${PAGE}, cursor: $cursor) { ${ITEM_FIELDS} } }`,
          { cursor: page.cursor, columnIds },
        );
        page = next.next_items_page;
      }
      return people;
    },
    async writeLabel(settings, write) {
      // A label by its text; an empty string clears the column.
      const value = write.label === '' ? '' : { label: write.label };
      await request(
        'mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }',
        { b: settings.boardId, i: write.itemId, v: JSON.stringify({ [settings.columns.label]: value }) },
      );
    },
  };
}
