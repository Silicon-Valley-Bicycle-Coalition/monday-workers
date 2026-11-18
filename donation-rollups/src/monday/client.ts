import { fiscalYearFromDate } from '../rollups/compute';
import { parseAmountCents } from '../money';
import { parseHours } from '../membership/volunteer';
import type { BoardMembership } from '../membership/derive';
import type { EmployerAffiliation } from '../affiliations/employer';
import type { EmployerSyncConfig, OwnerMembershipColumns, VolunteerBoardConfig, HistoricalVolunteerBoardConfig, RecurringGiftsConfig, RollCallConfig } from '../types';
import {
  AmbiguousWriteError, MONDAY_API_VERSION, MondayApiError, MondayGraphQL,
  type MondayErrorDetails, type MondayGraphQLOptions, type RequestOptions, type TokenProvider,
} from './graphql';

function chunksOf<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface DonationRecord {
  id: string;
  amountCents: number; // integer cents — see money.ts
  dateISO: string;
  fiscalYear: number;
  status: string;
  giftType?: string | null; // present when the board's Gift Type column is configured
  // Present when the board's membership term columns are configured; '' reads as null.
  termStart?: string | null;
  termEnd?: string | null;
  membershipType?: string | null;
  // The Affiliation item this donation's Acting for column points at. undefined when the
  // board has no actingForLink configured; null when the column is configured but empty.
  actingForItemId?: string | null;
  // Sponsorship facts; each undefined when its column isn't configured on the board.
  sponsorshipCycle?: string | null; // trimmed text, null when blank
  inKindValueCents?: number | null; // parseAmountCents of the cell, null when blank
  pipelineItemId?: string | null; // first linked id across sponsorshipPipelineLinks, null when none
  // The item is archived: its board_relation columns read back empty (issue GL#26), so link-derived facts are unreliable.
  archived?: boolean;
}

export interface AffiliationSummary {
  name: string;
  personItemId: string | null;
  personBoardId: string | null;
}

export type ItemState = 'active' | 'archived' | 'deleted';

// One item's requested columns from pageItemsColumnsText: text ('' reads as null) and the raw
// stored value JSON (null for an empty cell). The real client also fills the item's name, its
// group and each connect column's linked item ids; they're optional so fakes needn't.
export interface ItemColumns {
  id: string; text: Map<string, string | null>; values: Map<string, string | null>;
  name?: string; groupId?: string; linkedIds?: Map<string, string[]>;
}

export interface RegistrationRecord {
  id: string;
  // An item items(ids:) no longer returns at all is read as null, not 'deleted'.
  state: ItemState;
  attendeeItemId: string | null;
  eventItemId: string | null;
  attendanceLabel: string | null;
  roleLabel: string | null;
  hours: number | null;
}

export interface RecurringGiftRecord {
  id: string;
  statusLabel: string | null;
  donorItemIds: string[];
}

export interface DonationCreditRecord {
  id: string;
  // From Fiscal Year Ending, else derived from the Date (as getDonationsByIds does); 0 when
  // neither gives a year.
  fiscalYear: number;
  // null for a blank or unparseable Amount: it doesn't count, but the gift's credit (anonymous,
  // Matched By) is still decided from its flags.
  amountCents: number | null;
  status: string | null;
  giftType: string;
  donorItemIds: string[];
  matchedByItemIds: string[];
  anonymous: boolean;
  // null when blank, unparseable or not configured; counted only when Amount is blank (spec §10.3).
  inKindValueCents: number | null;
  // The Recognition Fiscal Year cell as typed, trimmed; '' when blank or not configured. Parsed by
  // the rollcall duty (recognitionYear), which reports a value it can't read.
  recognitionFiscalYear: string;
}

export interface HistoricalShiftRecord {
  id: string;
  volunteerItemId: string | null;
  dateISO: string | null;
  hours: number | null;
  statusLabel: string | null;
  // The Historical checkbox is checked; false when the board config names no such column.
  historical: boolean;
}

export type DonationReadColumns = {
  amount: string; date: string; fiscalYear: string | null; status: string;
  giftType?: string | null; termStart?: string | null; termEnd?: string | null; membershipType?: string | null;
  actingForLink?: string | null;
  sponsorshipCycle?: string | null; inKindValue?: string | null; sponsorshipPipelineLinks?: string[];
};

export interface DonationRollupsMondayClient {
  // Which board an item lives on — used to tell a Donor-owner from an Organization-owner
  // so the right ownerColumnsByBoard set gets written to.
  getItemBoardId(itemId: string): Promise<string | null>;
  // The owner (Donor or Organization) a Donation item's connect column currently points
  // at — null if the Donation is unlinked (nothing to recompute).
  getDonorLinkForDonation(donationItemId: string, donorLinkColumnId: string): Promise<string | null>;
  // The same link plus the owner's board in ONE query (issue GL#89), replacing the
  // getDonorLinkForDonation + getItemBoardId pair on the hot path. ownerBoardId is null when the
  // owner is deleted or no longer returned — what getItemBoardId reads as gone.
  getDonorLinkWithBoard(donationItemId: string, donorLinkColumnId: string): Promise<{ ownerItemId: string; ownerBoardId: string | null } | null>;
  // Why a Donation's Donor link read back empty (issue GL#26): 'archived' (board_relation reads
  // empty on archived items — the gift still counts), 'deleted' (gone, or no longer returned),
  // or 'active' (staff genuinely cleared the link — it no longer counts for anyone).
  getDonationState(donationItemId: string): Promise<'active' | 'archived' | 'deleted'>;
  // Fetches specific Donation items *by id* — not by filtering the board on its Donor
  // column, which Monday's API doesn't support for board_relation columns (confirmed
  // 2026-08-24: items_page_by_column_values rejects it outright). Callers get the id
  // list from the D1 donation_links reverse index (db/links.ts), grouped by which
  // Donations board each id lives on, since column ids differ per board.
  // fiscalYearStartMonth (config "fiscalYear.startMonth") derives a gift's fiscal year from its
  // Date when the board has no Fiscal Year column or the cell is blank.
  getDonationsByIds(
    itemIds: string[],
    columns: DonationReadColumns,
    fiscalYearStartMonth: number,
  ): Promise<DonationRecord[]>;
  // Each item's board id and group title; an item Monday no longer returns is absent from the map.
  getItemsBoardAndGroup(itemIds: string[]): Promise<Map<string, { boardId: string; groupTitle: string }>>;
  // The eight membership columns on a People-type owner, as label/date text — the membership
  // step's "what does the board hold" read (spec §"Merge with the board"). A missing item
  // reads as all-null so a deleted owner degrades to "never a member", not a thrown recompute.
  getOwnerMembership(ownerItemId: string, columns: OwnerMembershipColumns): Promise<BoardMembership>;
  // A registration item (event attendance) with all its fields parsed and links resolved.
  getRegistration(itemId: string, board: VolunteerBoardConfig): Promise<RegistrationRecord | null>;
  // The start date of an event item, normalized to YYYY-MM-DD, or null if missing/blank.
  getEventStart(eventItemId: string, startColumnId: string): Promise<string | null>;
  // A page of registration items with cursor pagination.
  pageRegistrations(board: VolunteerBoardConfig, cursor: string | null): Promise<{ items: RegistrationRecord[]; cursor: string | null }>;
  // A page of historical shift items with cursor pagination.
  pageHistoricalShifts(board: HistoricalVolunteerBoardConfig, cursor: string | null): Promise<{ items: HistoricalShiftRecord[]; cursor: string | null }>;
  // Map item IDs to their board IDs, chunked at 100; missing items absent from the result.
  getItemsBoardIds(itemIds: string[]): Promise<Map<string, string>>;
  // The Affiliation item's own name and the Person it links to (and that Person's board,
  // needed since Person items can live on the Donor or Organization board) — null when the
  // Affiliation item itself has been deleted.
  getAffiliationSummary(affiliationItemId: string, personLinkColumnId: string): Promise<AffiliationSummary | null>;
  // A person's Employer Name and Affiliations link. Null for a person in the trash or gone.
  getPersonEmployerState(personItemId: string, columns: { employerName: string; affiliationsLink: string }):
    Promise<{ employerName: string; affiliationItemIds: string[] } | null>;
  // What decides Employer Name on each affiliation; items not active are left out.
  getEmployerAffiliations(affiliationItemIds: string[], columns: EmployerSyncConfig['columns']): Promise<EmployerAffiliation[]>;
  // Rewrites an owner item's description with the markdown gift-history projection.
  setItemDescription(itemId: string, markdown: string): Promise<void>;
  // All items on one Donations board, each with its raw Donor-link value — used only
  // by the one-time bootstrap that populates donation_links, never by normal webhook
  // processing.
  listDonationOwnerLinks(boardId: number, donorLinkColumnId: string): Promise<{ itemId: string; ownerItemId: string | null }[]>;
  changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>,
    opts?: { createLabelsIfMissing?: boolean }): Promise<void>;
  // Posts an update on an item — the consumer's alert path for oversized gift-ledger
  // projections (same Monday alert item the custodian duties use).
  createUpdate(itemId: number, body: string): Promise<void>;
}

// API-Version comes from the transport's single pin (MONDAY_API_VERSION in graphql.ts, GL#39).
// Queue-consumer tuning (GL#35), same as the other queue Workers: a few quick in-process retries
// ride out a Monday blip or the per-minute complexity budget. Anything longer surfaces as a
// MondayRateLimitError carrying Monday's hint, and the consumer defers the batch by it
// (consumer/quota.ts) — including the daily limit, which the transport never retries in-process.
// On Workers Paid (confirmed 2026-09-29) the retried fetches' extra subrequests are well inside
// the 10,000-per-invocation limit, and waiting doesn't count against the 100 ms CPU cap.
const DEFAULT_OPTIONS: MondayGraphQLOptions = { maxAttempts: 3, requestTimeoutMs: 30_000 };

// Monday's per-token complexity budget, per-minute and daily call limits, and concurrency cap
// (issue GL#27). The consumer retries these after a delay instead of immediately; retryInSeconds
// is Monday's own hint (extensions.retry_in_seconds, a Retry-After header, or the legacy
// "reset in N seconds" message) when it gave one. `daily` marks DAILY_LIMIT_EXCEEDED, which
// resets at midnight UTC (developer.monday.com/api-reference/docs/rate-limits) rather than
// within seconds, and isn't documented to carry a hint.
export class MondayRateLimitError extends MondayApiError {
  constructor(message: string, readonly retryInSeconds?: number, readonly daily = false, details: MondayErrorDetails = {}) {
    super(message, details);
    this.name = 'MondayRateLimitError';
  }
}

const RATE_LIMIT_CODES = new Set([
  'COMPLEXITY_BUDGET_EXHAUSTED', 'ComplexityException', 'RATE_LIMIT_EXCEEDED',
  'IP_RATE_LIMIT_EXCEEDED', 'DAILY_LIMIT_EXCEEDED', 'maxConcurrencyExceeded',
]);
const RATE_LIMIT_TEXT = /complexity budget exhausted|rate limit exceeded/i;

// Reclassifies a transport error as a MondayRateLimitError when any signal says rate limit (an
// HTTP or legacy-shape 429, a known code, or the message text); otherwise null, and the
// transport's own MondayApiError stands. A write that may have committed is never reclassified.
function rateLimitErrorFrom(err: unknown): MondayRateLimitError | null {
  if (!(err instanceof MondayApiError) || err instanceof AmbiguousWriteError) return null;
  const limited = err.httpStatus === 429 || RATE_LIMIT_CODES.has(err.code ?? '') || RATE_LIMIT_TEXT.test(err.message);
  if (!limited) return null;
  // A zero hint is no hint: the consumer's backoff floor applies.
  const retryInSeconds = err.retryAfterSeconds ? err.retryAfterSeconds : undefined;
  return new MondayRateLimitError(err.message, retryInSeconds, err.code === 'DAILY_LIMIT_EXCEEDED', err);
}

interface ColumnValue { id: string; text: string | null; value?: string | null; display_value?: string | null; linked_item_ids?: string[] }

// A status cell's label, or null when the cell is empty. Read status columns with this, never
// by text alone: Monday returns label id 5's text for an EMPTY status cell, so a column with a
// real label at id 5 reads every blank cell as that label (sandbox rehearsal 2026-10-27). The
// stored value is null, or JSON without a numeric `index`, when the cell is empty.
export function statusLabel(text: string | null | undefined, value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { index?: unknown }).index !== 'number') return null;
  return text === null || text === undefined || text.trim() === '' ? null : text;
}

// A checkbox cell's value is JSON like {"checked":"true"} (Monday returns the string or the
// boolean), or null when never set.
function checkboxChecked(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value.trim() === '') return false;
  try {
    const checked = (JSON.parse(value) as { checked?: unknown } | null)?.checked;
    return checked === true || checked === 'true';
  } catch {
    return false;
  }
}

// The Donations columns the rollcall duty's credits read needs. Exported so the custodian's shared
// board read (custodian/boardReads.ts, issue GL#90) requests them alongside classify's.
export function donationCreditColumnIds(cfg: RollCallConfig['donations']): string[] {
  const c = cfg.columns;
  return [c.amount, c.date, c.status, c.fiscalYear, c.giftType, c.donorLink, c.matchedBy, c.anonymous,
    ...(c.inKindValue ? [c.inKindValue] : []), ...(c.recognitionFiscalYear ? [c.recognitionFiscalYear] : [])];
}

// One Donations item, as pageItemsColumnsText reads it, to the credits read's record.
export function donationCreditFrom(item: ItemColumns, cfg: RollCallConfig['donations'], fiscalYearStartMonth: number): DonationCreditRecord {
  const c = cfg.columns;
  const text = (id: string): string => item.text.get(id) ?? '';
  // A blank (or unparseable) Fiscal Year Ending falls back to the Date, as in getDonationsByIds —
  // the ledger's year for the same gift, so the two never disagree.
  const fyText = text(c.fiscalYear).trim();
  const dateISO = text(c.date).trim();
  const rawFY = fyText === '' ? NaN : Number(fyText);
  const fiscalYear = !Number.isNaN(rawFY) ? rawFY : dateISO ? fiscalYearFromDate(dateISO, fiscalYearStartMonth) : 0;
  return { id: item.id,
    fiscalYear: Number.isInteger(fiscalYear) ? fiscalYear : 0,
    amountCents: parseAmountCents(item.text.get(c.amount)),
    status: statusLabel(item.text.get(c.status), item.values.get(c.status)),
    giftType: text(c.giftType).trim(),
    donorItemIds: item.linkedIds?.get(c.donorLink) ?? [],
    matchedByItemIds: item.linkedIds?.get(c.matchedBy) ?? [],
    anonymous: checkboxChecked(item.values.get(c.anonymous)),
    inKindValueCents: c.inKindValue ? parseAmountCents(item.text.get(c.inKindValue)) : null,
    recognitionFiscalYear: c.recognitionFiscalYear ? text(c.recognitionFiscalYear).trim() : '' };
}

export class HttpMondayClient implements DonationRollupsMondayClient {
  private readonly transports = new Map<string, MondayGraphQL>();

  constructor(
    private apiUrl: string,
    // A fixed token, or the MONDAY_AUTH broker's provider (tokenProviderFor) — passed through to
    // MondayGraphQL, which re-asks a provider once on a 401.
    private apiToken: string | TokenProvider,
    private options: MondayGraphQLOptions = {},
  ) {}

  private transport(apiVersion: string): MondayGraphQL {
    let transport = this.transports.get(apiVersion);
    if (transport === undefined) {
      transport = new MondayGraphQL(this.apiUrl, this.apiToken, { ...DEFAULT_OPTIONS, ...this.options, apiVersion });
      this.transports.set(apiVersion, transport);
    }
    return transport;
  }

  private async graphql<T>(
    query: string, variables: Record<string, unknown>, apiVersion = MONDAY_API_VERSION, requestOptions?: RequestOptions,
  ): Promise<T> {
    try {
      return await this.transport(apiVersion).request<T>(query, variables, requestOptions);
    } catch (err) {
      throw rateLimitErrorFrom(err) ?? err;
    }
  }

  // items(ids:) keeps returning an item in Monday's trash, state 'deleted', board and columns
  // intact — so both reads below check state, or a deleted gift keeps its owner and a deleted
  // owner keeps being written to (each write failing, each message retrying toward the DLQ).
  async getItemBoardId(itemId: string): Promise<string | null> {
    const data = await this.graphql<{ items: { state?: string | null; board: { id: string } }[] }>(
      `query ($itemId: ID!) { items(ids: [$itemId]) { state board { id } } }`,
      { itemId },
    );
    const item = data.items[0];
    if (item === undefined || item.state === 'deleted') return null;
    return item.board.id;
  }

  async getDonorLinkForDonation(donationItemId: string, donorLinkColumnId: string): Promise<string | null> {
    const data = await this.graphql<{
      items: { state?: string | null; column_values: { id: string; linked_item_ids?: string[] }[] }[];
    }>(
      `query ($itemId: ID!, $columnId: [String!]) {
        items(ids: [$itemId]) {
          state
          column_values(ids: $columnId) { id ... on BoardRelationValue { linked_item_ids } }
        }
      }`,
      { itemId: donationItemId, columnId: [donorLinkColumnId] },
    );
    // A deleted gift links to no one: the caller's empty-link path asks getDonationState and detaches it.
    if (data.items[0]?.state === 'deleted') return null;
    const linked = data.items[0]?.column_values[0]?.linked_item_ids ?? [];
    return linked.length > 0 ? linked[0]! : null;
  }

  async getDonorLinkWithBoard(donationItemId: string, donorLinkColumnId: string): Promise<{ ownerItemId: string; ownerBoardId: string | null } | null> {
    const data = await this.graphql<{
      items: { state?: string | null; column_values: { id: string; linked_item_ids?: string[];
        linked_items?: { id: string; state?: string | null; board?: { id: string } | null }[] }[] }[];
    }>(
      `query ($itemId: ID!, $columnId: [String!]) {
        items(ids: [$itemId]) {
          state
          column_values(ids: $columnId) { id ... on BoardRelationValue { linked_item_ids linked_items { id state board { id } } } }
        }
      }`,
      { itemId: donationItemId, columnId: [donorLinkColumnId] },
    );
    if (data.items[0]?.state === 'deleted') return null;
    const column = data.items[0]?.column_values[0];
    const ownerItemId = column?.linked_item_ids?.[0];
    if (ownerItemId === undefined) return null;
    // A trashed owner keeps its board in items(ids:) (see getItemBoardId); treat it, and one that
    // linked_items doesn't return at all, as gone — the caller detaches rather than writing to it.
    const owner = column?.linked_items?.find((i) => i.id === ownerItemId);
    const ownerBoardId = owner === undefined || owner.state === 'deleted' ? null : owner.board?.id ?? null;
    return { ownerItemId, ownerBoardId };
  }

  async getDonationState(donationItemId: string): Promise<'active' | 'archived' | 'deleted'> {
    const data = await this.graphql<{ items: { state: string | null }[] }>(
      `query ($itemId: ID!) { items(ids: [$itemId]) { state } }`,
      { itemId: donationItemId },
    );
    const state = data.items[0]?.state;
    // items(ids:) stops returning an item once it's deleted; a returned 'deleted' state is the same.
    if (state === undefined || state === null || state === 'deleted') return 'deleted';
    return state === 'archived' ? 'archived' : 'active';
  }

  async getDonationsByIds(
    itemIds: string[],
    columns: DonationReadColumns,
    fiscalYearStartMonth: number,
  ): Promise<DonationRecord[]> {
    if (itemIds.length === 0) return [];
    const columnIds = [columns.amount, columns.date, columns.status,
      ...(columns.fiscalYear ? [columns.fiscalYear] : []),
      ...(columns.giftType ? [columns.giftType] : []),
      ...(columns.termStart ? [columns.termStart] : []),
      ...(columns.termEnd ? [columns.termEnd] : []),
      ...(columns.membershipType ? [columns.membershipType] : []),
      ...(columns.actingForLink ? [columns.actingForLink] : []),
      ...(columns.sponsorshipCycle ? [columns.sponsorshipCycle] : []),
      ...(columns.inKindValue ? [columns.inKindValue] : []),
      ...(columns.sponsorshipPipelineLinks ?? [])];
    const donations: DonationRecord[] = [];
    const optionalText = (byId: Map<string, string>, id: string | null | undefined): string | null | undefined =>
      id ? (byId.get(id) || null) : undefined;
    // Term dates are compared as YYYY-MM-DD, but Monday's `text` for a date column can carry a
    // time component (e.g. '2026-11-05 00:00') — normalize before it ever reaches a comparison.
    const optionalDate = (byId: Map<string, string>, id: string | null | undefined): string | null | undefined => {
      const t = optionalText(byId, id);
      return t ? t.slice(0, 10) : t;
    };
    // items(ids:) has a practical ceiling (Monday's complexity budget, not a documented
    // hard limit) — chunk defensively rather than assume any list size is safe.
    for (const chunk of chunksOf(itemIds, 100)) {
      // limit: 100 is load-bearing — items(ids:) silently returns only 25 items by default
      // even when handed 100 ids (verified live 2026-08-31; it surfaced as 75% of owners
      // "missing" in reconciliation and would have silently under-rolled any donor with
      // more than 25 gifts on one board).
      const data = await this.graphql<{ items: { id: string; state?: string | null; column_values: ColumnValue[] }[] }>(
        `query ($ids: [ID!], $columnIds: [String!]) {
          items(ids: $ids, limit: 100) { id state column_values(ids: $columnIds) { id text value ... on BoardRelationValue { linked_item_ids } } }
        }`,
        { ids: chunk, columnIds },
      );
      for (const item of data.items) {
        // A trashed gift still reads its columns; returned here, refreshFacts would re-assert it
        // (clearing removed_at) and it would keep counting toward its owner.
        if (item.state === 'deleted') continue;
        const byId = new Map(item.column_values.map((cv) => [cv.id, cv.text ?? '']));
        const statusCell = item.column_values.find((cv) => cv.id === columns.status);
        // A blank Amount must be treated as malformed like a blank Date — never as $0, which
        // would refresh the ledger's real (bootstrap-loaded) amount down to $0 on the next
        // recompute (refreshFacts would see a changed amount and write it). Parsed straight
        // to integer cents (issue GL#27): "1,234.5", "-12.34", "(12.34)" all parse; blank is null.
        const amountCents = parseAmountCents(byId.get(columns.amount));
        const dateISO = byId.get(columns.date) ?? '';
        const status = statusLabel(statusCell?.text, statusCell?.value) ?? '';
        if (!dateISO || amountCents === null) continue; // malformed or deleted item, skip
        // Fall back to deriving from the Date column when this board has no Fiscal
        // Year column yet, or the cell is blank — see fiscalYearFromDate in
        // rollups/compute.ts. Blank has to be checked as text, same as Amount above:
        // Number('') is 0, and a fiscalYear of 0 never matches This/Last Year, so a
        // gift with an unstamped cell (hand-created, or funraise-sync's create path,
        // which doesn't set the column) silently dropped out of both buckets
        // (observed live on the CRM Sandbox 2026-09-17).
        const fyText = columns.fiscalYear ? (byId.get(columns.fiscalYear) ?? '').trim() : '';
        const rawFY = fyText === '' ? NaN : Number(fyText);
        const fiscalYear = Number.isNaN(rawFY) ? fiscalYearFromDate(dateISO, fiscalYearStartMonth) : rawFY;
        const giftType = columns.giftType ? (byId.get(columns.giftType) || null) : undefined;
        const actingForItemId = columns.actingForLink
          ? (item.column_values.find((cv) => cv.id === columns.actingForLink)?.linked_item_ids?.[0] ?? null)
          : undefined;
        const optionalTrimmed = (id: string | null | undefined): string | null | undefined =>
          id ? (byId.get(id)?.trim() || null) : undefined;
        const pipelineItemId = columns.sponsorshipPipelineLinks?.length
          ? (columns.sponsorshipPipelineLinks
              .flatMap((id) => item.column_values.find((cv) => cv.id === id)?.linked_item_ids ?? [])[0] ?? null)
          : undefined;
        donations.push({
          id: item.id, amountCents, dateISO, fiscalYear, status, giftType,
          termStart: optionalDate(byId, columns.termStart),
          termEnd: optionalDate(byId, columns.termEnd),
          membershipType: optionalText(byId, columns.membershipType),
          actingForItemId,
          sponsorshipCycle: optionalTrimmed(columns.sponsorshipCycle),
          inKindValueCents: columns.inKindValue ? parseAmountCents(byId.get(columns.inKindValue)) : undefined,
          pipelineItemId,
          archived: item.state === 'archived',
        });
      }
    }
    return donations;
  }

  async getItemsBoardAndGroup(itemIds: string[]): Promise<Map<string, { boardId: string; groupTitle: string }>> {
    const out = new Map<string, { boardId: string; groupTitle: string }>();
    for (const chunk of chunksOf(itemIds, 100)) {
      // limit: 100 — same silent-25 default as getDonationsByIds above.
      const data = await this.graphql<{ items: { id: string; board: { id: string } | null; group: { title: string } | null }[] }>(
        `query ($ids: [ID!]) { items(ids: $ids, limit: 100) { id board { id } group { title } } }`,
        { ids: chunk },
      );
      for (const item of data.items) {
        if (item.board) out.set(item.id, { boardId: item.board.id, groupTitle: item.group?.title ?? '' });
      }
    }
    return out;
  }

  async getOwnerMembership(ownerItemId: string, columns: OwnerMembershipColumns): Promise<BoardMembership> {
    const ids = [columns.status, columns.tier, columns.since, columns.until,
      columns.currentTermStart, columns.memberType, columns.lapseCount, columns.lastLapsed];
    const data = await this.graphql<{ items: { id: string; column_values: ColumnValue[] }[] }>(
      `query ($ids: [ID!], $columnIds: [String!]) {
        items(ids: $ids) { id column_values(ids: $columnIds) { id text value } }
      }`,
      { ids: [ownerItemId], columnIds: ids },
    );
    const byId = new Map((data.items[0]?.column_values ?? []).map((cv) => [cv.id, cv]));
    const text = (id: string): string | null => byId.get(id)?.text || null;
    const label = (id: string): string | null => statusLabel(byId.get(id)?.text, byId.get(id)?.value);
    const date = (id: string): string | null => text(id)?.slice(0, 10) ?? null;
    const count = text(columns.lapseCount);
    return {
      statusLabel: label(columns.status), tierLabel: label(columns.tier), since: date(columns.since), until: date(columns.until),
      currentTermStart: date(columns.currentTermStart), memberTypeLabel: label(columns.memberType),
      lapseCount: count === null || !/^\d+$/.test(count.trim()) ? null : Number(count.trim()),
      lastLapsed: date(columns.lastLapsed),
    };
  }

  private registrationFrom(item: { id: string; state?: string | null; column_values: ColumnValue[] }, board: VolunteerBoardConfig): RegistrationRecord {
    const c = board.columns;
    const byId = new Map(item.column_values.map((cv) => [cv.id, cv]));
    const link = (id: string): string | null => byId.get(id)?.linked_item_ids?.[0] ?? null;
    const text = (id: string | null): string | null => (id ? (byId.get(id)?.text || null) : null);
    const label = (id: string): string | null => statusLabel(byId.get(id)?.text, byId.get(id)?.value);
    const state: ItemState = item.state === 'archived' ? 'archived' : item.state === 'deleted' ? 'deleted' : 'active';
    return { id: item.id, state, attendeeItemId: link(c.attendee), eventItemId: link(c.event),
      attendanceLabel: label(c.attendance), roleLabel: label(c.role), hours: parseHours(text(c.hours)) };
  }

  private registrationColumnIds(board: VolunteerBoardConfig): string[] {
    const c = board.columns;
    return [c.attendee, c.event, c.attendance, c.role, ...(c.hours ? [c.hours] : [])];
  }

  async getRegistration(itemId: string, board: VolunteerBoardConfig): Promise<RegistrationRecord | null> {
    const data = await this.graphql<{ items: { id: string; state: string | null; column_values: ColumnValue[] }[] }>(
      `query ($ids: [ID!], $columnIds: [String!]) {
        items(ids: $ids) { id state column_values(ids: $columnIds) { id text value ... on BoardRelationValue { linked_item_ids } } }
      }`,
      { ids: [itemId], columnIds: this.registrationColumnIds(board) },
    );
    const item = data.items[0];
    return item === undefined ? null : this.registrationFrom(item, board);
  }

  async getEventStart(eventItemId: string, startColumnId: string): Promise<string | null> {
    const text = (await this.getItemsColumnsText([eventItemId], [startColumnId])).get(eventItemId)?.get(startColumnId) ?? null;
    return text === null ? null : text.slice(0, 10);
  }

  async pageRegistrations(board: VolunteerBoardConfig, cursor: string | null) {
    const data: { boards: { items_page: { cursor: string | null; items: { id: string; state: string | null; column_values: ColumnValue[] }[] } }[] } =
      await this.graphql(
        `query ($boardId: [ID!], $columnIds: [String!], $cursor: String) {
          boards(ids: $boardId) {
            items_page(limit: 500, cursor: $cursor) { cursor items { id state column_values(ids: $columnIds) { id text value ... on BoardRelationValue { linked_item_ids } } } }
          }
        }`,
        { boardId: [board.boardId], columnIds: this.registrationColumnIds(board), cursor },
      );
    const page = data.boards[0]?.items_page;
    if (page === undefined) return { items: [], cursor: null };
    return { cursor: page.cursor, items: page.items.map((item) => this.registrationFrom(item, board)) };
  }

  async pageHistoricalShifts(board: HistoricalVolunteerBoardConfig, cursor: string | null) {
    const c = board.columns;
    const data: { boards: { items_page: { cursor: string | null; items: { id: string; column_values: ColumnValue[] }[] } }[] } =
      await this.graphql(
        `query ($boardId: [ID!], $columnIds: [String!], $cursor: String) {
          boards(ids: $boardId) {
            items_page(limit: 500, cursor: $cursor) { cursor items { id column_values(ids: $columnIds) { id text value ... on BoardRelationValue { linked_item_ids } } } }
          }
        }`,
        { boardId: [board.boardId], columnIds: [c.volunteer, c.date, c.hours, c.status, ...(c.historical ? [c.historical] : [])], cursor },
      );
    const page = data.boards[0]?.items_page;
    if (page === undefined) return { items: [], cursor: null };
    return {
      cursor: page.cursor,
      items: page.items.map((item) => {
        const byId = new Map(item.column_values.map((cv) => [cv.id, cv]));
        const text = (id: string): string | null => byId.get(id)?.text || null;
        return { id: item.id, volunteerItemId: byId.get(c.volunteer)?.linked_item_ids?.[0] ?? null,
          dateISO: text(c.date)?.slice(0, 10) ?? null, hours: parseHours(text(c.hours)),
          statusLabel: statusLabel(byId.get(c.status)?.text, byId.get(c.status)?.value),
          historical: c.historical ? checkboxChecked(byId.get(c.historical)?.value) : false };
      }),
    };
  }

  async pageRecurringGifts(board: RecurringGiftsConfig, cursor: string | null) {
    const c = board.columns;
    const data: { boards: { items_page: { cursor: string | null; items: { id: string; column_values: ColumnValue[] }[] } }[] } =
      await this.graphql(
        `query ($boardId: [ID!], $columnIds: [String!], $cursor: String) {
          boards(ids: $boardId) {
            items_page(limit: 500, cursor: $cursor) { cursor items { id column_values(ids: $columnIds) { id text value ... on BoardRelationValue { linked_item_ids } } } }
          }
        }`,
        { boardId: [board.boardId], columnIds: [c.donorLink, c.status], cursor },
      );
    const page = data.boards[0]?.items_page;
    if (page === undefined) return { items: [], cursor: null };
    return {
      cursor: page.cursor,
      items: page.items.map((item) => {
        const byId = new Map(item.column_values.map((cv) => [cv.id, cv]));
        const status = byId.get(c.status);
        return { id: item.id, statusLabel: statusLabel(status?.text, status?.value),
          donorItemIds: byId.get(c.donorLink)?.linked_item_ids ?? [] };
      }),
    };
  }

  // The rollcall duty's only read of Donations: an empty read would resolve every stored credit
  // through getItemsState, so a board Monday doesn't return is an error, not empty (requireBoard).
  async pageDonationCredits(cfg: RollCallConfig['donations'], cursor: string | null, fiscalYearStartMonth: number) {
    const page = await this.pageItemsColumnsText(cfg.boardId, donationCreditColumnIds(cfg), cursor, { requireBoard: true });
    return { cursor: page.cursor, items: page.items.map((item) => donationCreditFrom(item, cfg, fiscalYearStartMonth)) };
  }

  async getItemsState(itemIds: string[]): Promise<Map<string, 'active' | 'archived' | 'deleted'>> {
    const out = new Map<string, 'active' | 'archived' | 'deleted'>();
    for (const chunk of chunksOf(itemIds, 100)) {
      // items(ids:) defaults to 25 without a limit.
      const data = await this.graphql<{ items: { id: string; state: string }[] }>(
        `query ($ids: [ID!]) { items(ids: $ids, limit: 100) { id state } }`, { ids: chunk });
      for (const item of data.items) {
        if (item.state === 'active' || item.state === 'archived' || item.state === 'deleted') out.set(item.id, item.state);
      }
    }
    return out;
  }

  async getItemsBoardIds(itemIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const chunk of chunksOf(itemIds, 100)) {
      const data = await this.graphql<{ items: { id: string; board: { id: string } }[] }>(
        `query ($ids: [ID!]) { items(ids: $ids, limit: 100) { id board { id } } }`, { ids: chunk });
      for (const item of data.items) out.set(item.id, item.board.id);
    }
    return out;
  }

  async getAffiliationSummary(affiliationItemId: string, personLinkColumnId: string): Promise<AffiliationSummary | null> {
    const data = await this.graphql<{ items: { id: string; name: string; column_values: { id: string; linked_item_ids?: string[] }[] }[] }>(
      `query ($itemId: ID!, $columnId: [String!]) {
        items(ids: [$itemId]) { id name column_values(ids: $columnId) { id ... on BoardRelationValue { linked_item_ids } } }
      }`,
      { itemId: affiliationItemId, columnId: [personLinkColumnId] },
    );
    const item = data.items[0];
    if (item === undefined) return null;
    const personItemId = item.column_values[0]?.linked_item_ids?.[0] ?? null;
    const personBoardId = personItemId === null ? null : await this.getItemBoardId(personItemId);
    return { name: item.name, personItemId, personBoardId };
  }

  async getPersonEmployerState(
    personItemId: string, columns: { employerName: string; affiliationsLink: string },
  ): Promise<{ employerName: string; affiliationItemIds: string[] } | null> {
    const data = await this.graphql<{ items: { state: string; column_values: { id: string; text: string | null; linked_item_ids?: string[] }[] }[] }>(
      `query ($itemId: ID!, $columnIds: [String!]) {
        items(ids: [$itemId]) { state column_values(ids: $columnIds) { id text ... on BoardRelationValue { linked_item_ids } } }
      }`,
      { itemId: personItemId, columnIds: [columns.employerName, columns.affiliationsLink] },
    );
    const item = data.items[0];
    if (item === undefined || item.state !== 'active') return null;
    const cell = (id: string) => item.column_values.find((c) => c.id === id);
    return { employerName: cell(columns.employerName)?.text ?? '', affiliationItemIds: cell(columns.affiliationsLink)?.linked_item_ids ?? [] };
  }

  async getEmployerAffiliations(affiliationItemIds: string[], columns: EmployerSyncConfig['columns']): Promise<EmployerAffiliation[]> {
    const data = await this.graphql<{ items: { id: string; state: string; column_values: {
      id: string; text: string | null; checked?: boolean | null; linked_items?: { name: string }[];
    }[] }[] }>(
      `query ($itemIds: [ID!], $limit: Int, $columnIds: [String!]) {
        items(ids: $itemIds, limit: $limit) { id state column_values(ids: $columnIds) {
          id text ... on CheckboxValue { checked } ... on BoardRelationValue { linked_items { name } }
        } }
      }`,
      { itemIds: affiliationItemIds, limit: affiliationItemIds.length, columnIds: [columns.status, columns.primary, columns.organizationLink] },
    );
    return data.items.filter((item) => item.state === 'active').map((item) => {
      const cell = (id: string) => item.column_values.find((c) => c.id === id);
      return {
        id: item.id,
        statusLabel: cell(columns.status)?.text ?? null,
        primary: cell(columns.primary)?.checked === true,
        organizationName: cell(columns.organizationLink)?.linked_items?.[0]?.name ?? null,
      };
    });
  }

  async listDonationOwnerLinks(
    boardId: number, donorLinkColumnId: string,
  ): Promise<{ itemId: string; ownerItemId: string | null }[]> {
    const out: { itemId: string; ownerItemId: string | null }[] = [];
    let cursor: string | null = null;
    do {
      const data: {
        boards: { items_page: {
          cursor: string | null;
          items: { id: string; column_values: { id: string; linked_item_ids?: string[] }[] }[];
        } }[];
      } = await this.graphql(
        `query ($boardId: [ID!], $columnId: [String!], $cursor: String) {
          boards(ids: $boardId) {
            items_page(limit: 100, cursor: $cursor) {
              cursor
              items { id column_values(ids: $columnId) { id ... on BoardRelationValue { linked_item_ids } } }
            }
          }
        }`,
        { boardId: [boardId], columnId: [donorLinkColumnId], cursor },
      );
      const page = data.boards[0]?.items_page;
      if (page === undefined) break;
      for (const item of page.items) {
        const linked = item.column_values[0]?.linked_item_ids ?? [];
        out.push({ itemId: item.id, ownerItemId: linked.length > 0 ? linked[0]! : null });
      }
      cursor = page.cursor;
    } while (cursor !== null);
    return out;
  }

  // Each column's text and raw stored value (null for an empty cell); read status columns
  // through statusLabel(text, value), not text alone. A connect (board_relation) column's text
  // is its linked item names: Monday returns text: null for those at API 2026-07 and puts the
  // names only in display_value, so that's read instead — without it, classify's Matched By
  // Company saw every gift as unlinked and never wrote (svbc-monday-migration#113).
  async pageItemsColumnsText(boardId: number, columnIds: string[], cursor: string | null, opts: { requireBoard?: boolean } = {}):
    Promise<{ items: ItemColumns[]; cursor: string | null }> {
    const data: { boards: { items_page: { cursor: string | null;
      items: { id: string; name: string; group: { id: string }; column_values: ColumnValue[] }[] } }[] } =
      await this.graphql(
        `query ($boardId: [ID!], $columnIds: [String!], $cursor: String) {
          boards(ids: $boardId) {
            items_page(limit: 500, cursor: $cursor) { cursor items { id name group { id }
              column_values(ids: $columnIds) { id text value ... on BoardRelationValue { display_value linked_item_ids } } } }
          }
        }`,
        { boardId: [boardId], columnIds, cursor },
      );
    const page = data.boards[0]?.items_page;
    if (page === undefined && opts.requireBoard) throw new Error(`monday API: board ${boardId} not returned (deleted, or not visible to this token)`);
    if (page === undefined) return { items: [], cursor: null };
    return {
      cursor: page.cursor,
      items: page.items.map((item) => {
        const text = new Map<string, string | null>(columnIds.map((id) => [id, null]));
        const values = new Map<string, string | null>(columnIds.map((id) => [id, null]));
        const linkedIds = new Map<string, string[]>();
        for (const cv of item.column_values) {
          const t = cv.text || cv.display_value;
          text.set(cv.id, t === null || t === undefined || t === '' ? null : t);
          values.set(cv.id, cv.value ?? null);
          if (cv.linked_item_ids !== undefined) linkedIds.set(cv.id, cv.linked_item_ids);
        }
        return { id: item.id, name: item.name, groupId: item.group?.id, text, values, linkedIds };
      }),
    };
  }

  async changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>,
    opts: { createLabelsIfMissing?: boolean } = {}): Promise<void> {
    await this.graphql<{ change_multiple_column_values: { id: string } }>(
      `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!, $create: Boolean) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues,
          create_labels_if_missing: $create) { id }
      }`,
      { boardId, itemId, columnValues: JSON.stringify(columnValues), create: opts.createLabelsIfMissing ?? false },
    );
  }

  async setItemDescription(itemId: string, markdown: string): Promise<void> {
    // set_item_description_content exists from API 2026-04 on; the transport's pin covers it.
    await this.graphql<{ set_item_description_content: { success: boolean } }>(
      `mutation ($itemId: ID!, $markdown: String!) {
        set_item_description_content(item_id: $itemId, markdown: $markdown) { success }
      }`,
      { itemId, markdown },
    );
  }

  // --- Custodian surface (docs/20 §5.3) ---

  async createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<string> {
    const data = await this.graphql<{ create_item: { id: string } }>(
      `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id }
      }`,
      { boardId: String(boardId), itemName, columnValues: JSON.stringify(columnValues) },
      MONDAY_API_VERSION,
      // Not idempotent: a create that may have committed throws AmbiguousWriteError.
      { idempotent: false },
    );
    return data.create_item.id;
  }

  // --- Donor Roll Call board (the `rollcall` duty) ---

  async listGroups(boardId: number): Promise<{ id: string; title: string }[]> {
    const data = await this.graphql<{ boards: { groups: { id: string; title: string }[] }[] }>(
      `query ($boardId: [ID!]) { boards(ids: $boardId) { groups { id title } } }`,
      { boardId: [boardId] },
    );
    return data.boards[0]?.groups.map((g) => ({ id: g.id, title: g.title })) ?? [];
  }

  async createGroup(boardId: number, title: string): Promise<string> {
    const data = await this.graphql<{ create_group: { id: string } }>(
      `mutation ($boardId: ID!, $title: String!) { create_group(board_id: $boardId, group_name: $title) { id } }`,
      { boardId: String(boardId), title },
      MONDAY_API_VERSION,
      // Not idempotent: a create that may have committed throws AmbiguousWriteError.
      { idempotent: false },
    );
    return data.create_group.id;
  }

  async updateGroupTitle(boardId: number, groupId: string, title: string): Promise<void> {
    await this.graphql<{ update_group: { id: string } }>(
      `mutation ($boardId: ID!, $groupId: String!, $title: String!) {
        update_group(board_id: $boardId, group_id: $groupId, group_attribute: title, new_value: $title) { id }
      }`,
      { boardId: String(boardId), groupId, title },
    );
  }

  async createItemInGroup(boardId: number, groupId: string, name: string, columnValues: Record<string, unknown>): Promise<string> {
    const data = await this.graphql<{ create_item: { id: string } }>(
      `mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
        create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) { id }
      }`,
      { boardId: String(boardId), groupId, itemName: name, columnValues: JSON.stringify(columnValues) },
      MONDAY_API_VERSION,
      // Not idempotent: a create that may have committed throws AmbiguousWriteError.
      { idempotent: false },
    );
    return data.create_item.id;
  }

  async moveItemToGroup(itemId: string, groupId: string): Promise<void> {
    await this.graphql<{ move_item_to_group: { id: string } }>(
      `mutation ($itemId: ID!, $groupId: String!) { move_item_to_group(item_id: $itemId, group_id: $groupId) { id } }`,
      { itemId, groupId },
    );
  }

  // An item already gone counts as deleted: the transport retries a delete whose response was
  // lost, and that retry finds nothing to delete. The codes are Monday's documented names (as in
  // eventbrite-sync's isItemGone), not all confirmed live; a miss just throws as before.
  async deleteItem(itemId: string): Promise<void> {
    try {
      await this.graphql<{ delete_item: { id: string } }>(
        `mutation ($itemId: ID!) { delete_item(item_id: $itemId) { id } }`,
        { itemId },
      );
    } catch (err) {
      if (err instanceof MondayApiError && !(err instanceof AmbiguousWriteError)
        && (/ItemNotFound|InvalidItemId|ResourceNotFound/i.test(err.code ?? '') || /item.{0,20}not found/i.test(err.message))) return;
      throw err;
    }
  }

  async archiveItem(itemId: string): Promise<void> {
    await this.graphql<{ archive_item: { id: string } }>(
      `mutation ($itemId: ID!) { archive_item(item_id: $itemId) { id } }`,
      { itemId },
    );
  }

  async listWorkspaceBoards(workspaceId: number): Promise<{ id: string; name: string; itemsCount: number; itemsLimit: number | null }[]> {
    const data = await this.graphql<{ boards: { id: string; name: string; items_count: number; items_limit: number | null }[] }>(
      `query ($workspaceId: [ID!]) {
        boards(workspace_ids: $workspaceId, limit: 100) { id name items_count items_limit }
      }`,
      { workspaceId: [workspaceId] },
    );
    return data.boards.map((b) => ({ id: b.id, name: b.name, itemsCount: b.items_count, itemsLimit: b.items_limit }));
  }

  async getItemsColumnsText(itemIds: string[], columnIds: string[]): Promise<Map<string, Map<string, string | null>>> {
    const out = new Map<string, Map<string, string | null>>();
    // 100 is a hard Monday API limit on items(ids:) — "Argument 'ids' exceeding the 100
    // limit", verified live 2026-08-31 — so large reads can't be squeezed into fewer
    // subrequests here; callers with big id sets must slice themselves (see runReconcile).
    // Multiple columns per item DO share one subrequest, which is why reconciliation
    // reads Lifetime Giving and the Gift Ledger JSON together instead of twice.
    for (const chunk of chunksOf(itemIds, 100)) {
      // limit: 100 — same silent-25 default as getDonationsByIds above.
      const data = await this.graphql<{ items: { id: string; column_values: ColumnValue[] }[] }>(
        `query ($ids: [ID!], $columnIds: [String!]) {
          items(ids: $ids, limit: 100) { id column_values(ids: $columnIds) { id text } }
        }`,
        { ids: chunk, columnIds },
      );
      for (const item of data.items) {
        const cols = new Map<string, string | null>(columnIds.map((id) => [id, null]));
        for (const cv of item.column_values) {
          cols.set(cv.id, cv.text === null || cv.text === '' ? null : cv.text);
        }
        out.set(item.id, cols);
      }
    }
    return out;
  }

  async createUpdate(itemId: number, body: string): Promise<void> {
    await this.graphql<{ create_update: { id: string } }>(
      `mutation ($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
      { itemId: String(itemId), body },
      MONDAY_API_VERSION,
      // Not idempotent: a repeat would post the alert twice.
      { idempotent: false },
    );
  }
}
