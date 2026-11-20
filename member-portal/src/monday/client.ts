import type {
  ChangeRequestColumns,
  Config,
  DiscountOrganization,
  DonationRecord,
  DonationsConfig,
  DonorContactInfo,
  DonorEmails,
  DonorMatch,
  EmployerAnswerConfig,
  MemberPortalData,
  OrganizationsConfig,
  EventRegistrationColumns,
  EventRegistrationRecord,
  LetterCronColumns,
  LetterSettings,
  MondayColumns,
  PledgeColumns,
  PledgeRecord,
  VolunteerShift,
} from '../types';
import type { AffiliationRecord } from '../changeRequests/employer';
import type { OrganizationCandidate } from '../changeRequests/employerName';
import type { Locale } from '../i18n/locales';
import { parseAmount as parseAmountOrNull } from '../amounts';
import { MondayGraphQL, type TokenProvider } from './graphql';
import { giftTypeIn } from '../letters/giftTypes';

export { AmbiguousWriteError, MondayApiError } from './graphql';

// API-Version comes from the transport's single pin (MONDAY_API_VERSION in graphql.ts, GL#39).

// Per-request ceiling on a Monday call (headers and body). Workers impose no wall-clock limit on a
// subrequest, so without this a hung Monday request held a dashboard render — or a queue consumer
// batch — open indefinitely (issue GL#31). Generous next to Monday's normal sub-second responses.
export const MONDAY_FETCH_TIMEOUT_MS = 15_000;

// One attempt per call, no in-process retry (GL#35). Most calls render a donor's page, where a
// retry's backoff (seconds) is worse than a fast error the donor can reload past. The queue
// consumers (change requests, letters) retry with their own backoff (queueRetry.ts).
const MAX_ATTEMPTS = 1;

interface MondayColumnValue {
  id: string;
  text: string | null;
  value?: string | null; // raw JSON; requested only where noted
  checked?: boolean; // CheckboxValue fragment
  linked_item_ids?: string[]; // BoardRelationValue fragment
  linked_items?: { name: string; id?: string; board?: { id: string } }[]; // BoardRelationValue fragment, only where noted
}

interface MondayItem {
  id: string;
  name: string;
  state?: string; // requested only where noted (active / archived / deleted)
  board?: { id: string }; // requested only where noted
  column_values?: MondayColumnValue[];
}

function columnText(item: MondayItem, columnId: string): string {
  return (item.column_values ?? []).find((c) => c.id === columnId)?.text ?? '';
}

// "Bike to Work Day — Shift 1": the Eventbrite ticket type after the Job (the event name, for
// eventbrite-sync rows), so two shifts at one event read as two (GL#115). Either alone when the
// other is blank; the Job alone when the ticket type only repeats it.
function jobWithTicketType(job: string, ticketType: string): string {
  const j = job.trim();
  const t = ticketType.trim();
  if (t === '' || t.toLowerCase() === j.toLowerCase()) return j;
  if (j === '') return t;
  return `${j} — ${t}`;
}

// The address on a donor's email column. An email column's value is {"email","text"} JSON, where
// text is a display label that can differ from the address; a plain text column's value is a JSON
// string. Falls back to the column's text when value is absent or unparseable.
function columnEmail(item: MondayItem, columnId: string): string {
  const column = (item.column_values ?? []).find((c) => c.id === columnId);
  if (!column) return '';
  try {
    const parsed: unknown = column.value ? JSON.parse(column.value) : null;
    if (typeof parsed === 'string') return parsed;
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { email?: unknown }).email === 'string') {
      return (parsed as { email: string }).email;
    }
  } catch {
    // fall through to text
  }
  return column.text ?? '';
}

// The https URL on a link column (value is {"url","text"} JSON), or null. Only https: this href
// is rendered into the portal, so javascript:/http: and malformed values are dropped.
function columnLinkUrl(item: MondayItem, columnId: string): string | null {
  const raw = (item.column_values ?? []).find((c) => c.id === columnId)?.value;
  if (!raw) return null;
  try {
    const url = (JSON.parse(raw) as { url?: unknown } | null)?.url;
    if (typeof url !== 'string') return null;
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// Monday checkbox columns render as text "v" when checked and "" (or an absent column_value)
// when not. An unconfigured column can't be read at all, so it maps to null, not false.
function checkboxState(item: MondayItem, columnId: string): boolean | null {
  if (columnId === 'REPLACE_WITH_COLUMN_ID') return null;
  return columnText(item, columnId) !== '';
}

// An Affiliations-board item as organization reps use it (spec 2026-11-19-member-portal-organization-reps-design.md).
export interface OrgAffiliation {
  id: string;
  personItemId: string | null;
  organizationId: string | null;
  statusLabel: string | null;
  portalAccess: boolean;
  workEmail: string; // '' when unset or the column is unconfigured
}

// A Donations-board gift as an organization sees it. giftType is the Gift Type column
// (donationDescription). The item's own name is deliberately not read: it can carry a person's name.
export interface OrgGift {
  itemId: string;
  date: string;
  amount: string;
  giftType: string;
}

// What the organization reads need beyond the board and column ids every client carries.
export interface OrgReadConfig {
  organizations: OrganizationsConfig;
  // The Affiliations board and its columns; null makes the affiliation reads throw a config error.
  employer: EmployerAnswerConfig | null;
  // volunteerHistory.completedStatuses; empty means every status counts.
  volunteerCompletedStatuses: string[];
}

export function orgReadConfig(config: Config): OrgReadConfig {
  return {
    organizations: config.organizations,
    employer: config.changeRequests.employer ?? null,
    volunteerCompletedStatuses: config.volunteerHistory.completedStatuses,
  };
}

export interface MondayClient {
  findDonorsByEmail(email: string): Promise<DonorMatch[]>;
  // includeDonations false skips the Donations-board read entirely (donations: [], totalDonated:
  // '') — for the portal home while donation history is gated off. Defaults to true so the
  // letters and card paths, which always need gifts, are unchanged.
  getMemberPortalData(donorItemId: string, options?: { includeDonations?: boolean }): Promise<MemberPortalData>;
  getDiscountOrganizations(): Promise<DiscountOrganization[]>;
  getVolunteerShiftsForDonor(donorItemId: string): Promise<VolunteerShift[]>;
  getDonorContactInfo(donorItemId: string): Promise<DonorContactInfo>;
  // Personal and Household Email with their consent labels, for the info door's address list.
  getDonorEmails(donorItemId: string): Promise<DonorEmails>;
  // Lightweight id+name lookup (one query for all ids) — exists so the pledges page can label
  // per-donor sections without getMemberPortalData's full donation-history fetch per donor.
  getDonorNames(donorItemIds: string[]): Promise<{ id: string; name: string }[]>;
  getPledgesForDonor(donorItemId: string): Promise<PledgeRecord[]>;
  // The id of the Change Requests item named exactly itemName, or null — lets the queue consumer
  // adopt an item an earlier, ambiguously failed create already committed (the name carries the
  // D1 request id, so it's unique per request).
  findChangeRequestItem(params: { boardId: number; itemName: string }): Promise<string | null>;
  // Donor employer answer (writer only). Exact-name lookup of every candidate spelling at once.
  findOrganizationsByNames(params: { boardId: number; names: string[] }): Promise<OrganizationCandidate[]>;
  getPersonAffiliations(params: { donorItemId: string; employer: EmployerAnswerConfig }): Promise<AffiliationRecord[]>;
  createAffiliation(params: { employer: EmployerAnswerConfig; itemName: string; donorItemId: string; organizationItemId: string }): Promise<void>;
  // makeCurrent false leaves Status alone; primary false clears the checkbox.
  updateAffiliation(params: { employer: EmployerAnswerConfig; itemId: string; makeCurrent: boolean; primary: boolean }): Promise<void>;
  createChangeRequestItem(params: {
    boardId: number;
    columns: ChangeRequestColumns;
    itemName: string;
    donorItemId: string;
    fieldLabel: string;
    oldValue: string;
    newValue: string;
    submittedAtISO: string;
  }): Promise<void>;
  getEventRegistrationsForDonor(params: {
    donorItemId: string;
    boardId: number;
    columns: EventRegistrationColumns;
    eventDateColumnId: string;
  }): Promise<EventRegistrationRecord[]>;
  getLetterSettings(params: {
    boardId: number;
    columns: LetterCronColumns;
    settingsItemName: string;
  }): Promise<LetterSettings | null>;
  // Exact, case-insensitive match on the Affiliations Work Email column; [] while it is unconfigured.
  findAffiliationsByWorkEmail(email: string): Promise<OrgAffiliation[]>;
  // null when the item is missing or not active.
  getAffiliation(affiliationItemId: string): Promise<OrgAffiliation | null>;
  // Active Affiliations whose Organization link is orgItemId.
  getOrganizationAffiliations(orgItemId: string): Promise<OrgAffiliation[]>;
  // null unless the item is active AND on the Organizations board.
  getOrganization(orgItemId: string): Promise<{ id: string; name: string; address: string } | null>;
  // Donations with Donor = the organization, under the same countable-status and history-floor rules as a donor's.
  getOrganizationGifts(orgItemId: string): Promise<OrgGift[]>;
  // Donations with Matched By = the organization; [] while Matched By is unconfigured.
  getOrganizationMatches(orgItemId: string): Promise<OrgGift[]>;
  // personItemId -> completed volunteer hours in the year, from one Volunteers-board sweep.
  getCompletedVolunteerHoursInYear(year: number): Promise<Map<string, number>>;
  // One sweep of the year's countable gifts, split by the board of the linked Donor: people (minus
  // excludedGiftTypes, the tax-letter rule) and organizations (any gift type, plus Matched By).
  listYearActivity(year: number, excludedGiftTypes: string[]): Promise<{ personIds: string[]; organizationIds: string[] }>;
}

export type DonationReadOptions = Pick<DonationsConfig, 'countableStatuses' | 'historyStartISO'>;

export class HttpMondayClient implements MondayClient {
  constructor(
    apiUrl: string,
    // A fixed token or a provider (tokenProviderFor in ./graphql) that fetches a fresh one per call.
    apiToken: string | TokenProvider,
    private columns: MondayColumns,
    private donorsBoardId: number,
    private donationsBoardId: number,
    private organizationsBoardId: number,
    // countableStatuses: Donations-board status labels that count as real gifts (config
    // donations.countableStatuses, e.g. ['Received', 'Received (Historical)']). historyStartISO:
    // the calendar-date floor (config donations.historyStartISO), or null for none. Every
    // donation read filters on both at this layer, so no consumer — portal history, letter
    // totals, the letter-cron sweep — can ever see a Failed or Pending item, or a pre-floor
    // gift, as real giving.
    private donations: DonationReadOptions,
    // null until an operator configures pledges.boardId + columns (the feature is gated on
    // pledgesEnabled, so routes never call getPledgesForDonor while this is null).
    private pledges: { boardId: number; columns: PledgeColumns } | null = null,
    // null until an operator configures monday.volunteersBoardId — getVolunteerShiftsForDonor
    // throws its own config error on null rather than querying a sentinel board id.
    private volunteersBoardId: number | null = null,
    // Tests inject a fetch mock. Absent, the transport looks up the global fetch per call, which
    // also avoids Cloudflare's "Illegal invocation" when native fetch is called as a method.
    fetchFn?: typeof fetch,
    // Organization-rep reads (affiliations, organizations, volunteer hours). Absent, the portal
    // access and Work Email columns read as unconfigured and the affiliation reads throw.
    private orgs: OrgReadConfig | null = null
  ) {
    this.transport = new MondayGraphQL(apiUrl, apiToken, {
      maxAttempts: MAX_ATTEMPTS,
      requestTimeoutMs: MONDAY_FETCH_TIMEOUT_MS,
      fetchFn,
    });
  }

  private readonly transport: MondayGraphQL;

  private async request<T>(query: string, variables: Record<string, unknown>, options?: { idempotent?: boolean }): Promise<T> {
    return this.transport.request<T>(query, variables, options);
  }

  async findDonorsByEmail(email: string): Promise<DonorMatch[]> {
    // `email` is attacker-controlled (it comes straight from the POST /login body), so it must
    // never be interpolated into the query string — it's passed as a proper GraphQL variable
    // ($email) instead, with only `compare_value: [$email]` referencing it. column_id stays
    // interpolated because it's a trusted config value, never attacker input. Verified live
    // against the sandbox Donors board on 2026-09-20: query_params.rules filtering on a text
    // column works with the value passed as-is, but the variable's declared type must be
    // `CompareValue`, not `String!` — the API rejects a `String!` variable used in a
    // CompareValue position (caught the same way the two NOTEs below were).
    // preferredLanguage is a gated/optional column, same convention as membershipExpiry in
    // getMemberPortalData below: only request it once it's been configured with a real column id,
    // so the literal placeholder never ships to Monday's API.
    const householdOn = this.columns.donorHouseholdEmail !== 'REPLACE_WITH_COLUMN_ID';
    const columnIds = [this.columns.donorEmail];
    if (householdOn) columnIds.push(this.columns.donorHouseholdEmail);
    if (this.columns.preferredLanguage !== 'REPLACE_WITH_COLUMN_ID') {
      columnIds.push(this.columns.preferredLanguage);
    }
    // Household Email is a second address that signs a donor in too (same gating as above): with it
    // configured the query ORs the two columns; without, it stays the single Personal Email rule.
    const rule = (columnId: string) => `{ column_id: "${columnId}", compare_value: [$email], operator: any_of }`;
    const rules = householdOn
      ? `rules: [${rule(this.columns.donorEmail)}, ${rule(this.columns.donorHouseholdEmail)}], operator: or`
      : `rules: [${rule(this.columns.donorEmail)}]`;
    const query = `
      query ($boardId: ID!, $email: CompareValue) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 25,
            query_params: {
              ${rules}
            }
          ) {
            items { id name column_values(ids: ${JSON.stringify(columnIds)}) { id text value } }
          }
        }
      }
    `;
    const data = await this.request<{ boards: { items_page: { items: MondayItem[] } }[] }>(query, {
      boardId: this.donorsBoardId,
      email,
    });
    const items = data.boards[0]?.items_page.items ?? [];
    // Monday's filter is not an exact-address match we can rely on (issue GL#62): keep only items
    // whose address equals the submitted one, ignoring case and surrounding whitespace, so a login
    // link never goes out for a donor record holding some other address.
    const wanted = email.trim().toLowerCase();
    return items
      .filter(
        (item) =>
          columnEmail(item, this.columns.donorEmail).trim().toLowerCase() === wanted ||
          (householdOn && columnEmail(item, this.columns.donorHouseholdEmail).trim().toLowerCase() === wanted),
      )
      .map((item) => ({
        id: item.id,
        name: item.name,
        preferredLanguage: columnText(item, this.columns.preferredLanguage),
        matchedPersonal: columnEmail(item, this.columns.donorEmail).trim().toLowerCase() === wanted,
      }));
  }

  async getMemberPortalData(donorItemId: string, options: { includeDonations?: boolean } = {}): Promise<MemberPortalData> {
    // getMemberPortalData backs /portal and /portal/letters, which run for EVERY donor
    // regardless of whether the (gated, placeholder-tolerant) membership-card feature is
    // enabled. membershipExpiry only matters to that gated feature, so it's deliberately left
    // as the placeholder id until an operator fills it in — including it in this always-on
    // query unconditionally would ship the literal placeholder string to Monday's API on every
    // portal request. Only request it once it's been configured with a real column id.
    const donorColumnIds = [this.columns.membershipStatus, this.columns.membershipTier, this.columns.dollarDonated];
    if (this.columns.membershipExpiry !== 'REPLACE_WITH_COLUMN_ID') {
      donorColumnIds.push(this.columns.membershipExpiry);
    }
    // memberSince / memberType: same gating, for the home page's state resolver.
    const memberSinceOn = this.columns.memberSince !== 'REPLACE_WITH_COLUMN_ID';
    const memberTypeOn = this.columns.memberType !== 'REPLACE_WITH_COLUMN_ID';
    if (memberSinceOn) donorColumnIds.push(this.columns.memberSince);
    if (memberTypeOn) donorColumnIds.push(this.columns.memberType);
    // The DTD link is only read when the whole match-line feature is on and donations are loaded.
    const matchLines = this.matchLinesOn();
    if (matchLines && options.includeDonations !== false) {
      donorColumnIds.push(this.columns.donorDtdLink);
    }
    const donorQuery = `
      query ($itemId: ID!) {
        items(ids: [$itemId]) {
          id
          name
          column_values(ids: ${JSON.stringify(donorColumnIds)}) {
            id
            text
            value
          }
        }
      }
    `;
    // The donor item and its donations are independent reads (the donations query needs only
    // donorItemId), so they run concurrently (GL#99): one Monday round trip per page, not two.
    // allSettled, then the donor result first, so a failure surfaces the same error the serial
    // version did (donor read or not-found before any donations error) and no rejection is left
    // unhandled.
    const includeDonations = options.includeDonations ?? true;
    const [donorResult, donationsResult] = await Promise.allSettled([
      this.request<{ items: MondayItem[] }>(donorQuery, { itemId: donorItemId }),
      includeDonations ? this.getDonationsForDonor(donorItemId) : Promise.resolve({ records: [], awaitingDonor: [] }),
    ]);
    if (donorResult.status === 'rejected') throw donorResult.reason;
    const donorItem = donorResult.value.items[0];
    if (!donorItem) {
      throw new Error(`monday: donor item "${donorItemId}" not found`);
    }
    if (donationsResult.status === 'rejected') throw donationsResult.reason;
    const { records: donations, awaitingDonor } = donationsResult.value;
    // The DTD "Waiting for donor" hint needs the donor item's DTD link, so it's attached here,
    // once both reads are back, rather than inside getDonationsForDonor.
    const dtdUrl = matchLines ? columnLinkUrl(donorItem, this.columns.donorDtdLink) : null;
    if (dtdUrl !== null) {
      for (const i of awaitingDonor) donations[i]!.matchHintUrl = dtdUrl;
    }
    // With a history floor, the Lifetime Giving rollup would exceed the rows the donor can see,
    // so the total becomes the sum of the kept gifts. Without one, the rollup column is the
    // total, as before. Not loaded at all → '' rather than a misleading zero.
    const totalDonated = !includeDonations
      ? ''
      : this.donations.historyStartISO === null
        ? columnText(donorItem, this.columns.dollarDonated)
        : String(donations.reduce((sum, d) => sum + (parseAmountOrNull(d.amount) ?? 0), 0));

    return {
      id: donorItem.id,
      name: donorItem.name,
      membershipStatus: columnText(donorItem, this.columns.membershipStatus),
      membershipTier: columnText(donorItem, this.columns.membershipTier),
      totalDonated,
      donations,
      membershipExpiry: columnText(donorItem, this.columns.membershipExpiry),
      memberSince: memberSinceOn ? columnText(donorItem, this.columns.memberSince) : '',
      memberType: memberTypeOn ? columnText(donorItem, this.columns.memberType) : '',
    };
  }

  // The pages after an items_page's first: follows next_items_page until the cursor runs out.
  // `itemsSelection` is the same `items { ... }` selection the first page used. A null
  // next_items_page (expired/invalid cursor) ends pagination with what we have rather than
  // throwing mid-read — for the January cron sweep an exception costs a whole day's run.
  private async remainingPages(cursor: string | null, itemsSelection: string): Promise<MondayItem[]> {
    const nextPageQuery = `
      query ($cursor: String!) {
        next_items_page(cursor: $cursor, limit: 500) {
          cursor
          ${itemsSelection}
        }
      }
    `;
    const items: MondayItem[] = [];
    while (cursor) {
      const nextData = await this.request<{
        next_items_page: { cursor: string | null; items: MondayItem[] } | null;
      }>(nextPageQuery, { cursor });
      const nextPage = nextData.next_items_page;
      if (!nextPage) break;
      items.push(...nextPage.items);
      cursor = nextPage.cursor;
    }
    return items;
  }

  // Shared by getDonationsForDonor, getPledgesForDonor, and getVolunteerShiftsForDonor: every item on a board whose
  // connect-board column links to donorItemId, following the cursor across pages.
  // Verified live against the sandbox Donations board on 2026-09-20. Two things the "current API
  // knowledge" version got wrong: the variable's declared type must be `CompareValue`, not
  // `String!` (same fix as findDonorsByEmail above); and — the real catch — a connect-board
  // column's compare_value must be the linked item's id as a JSON *number*, not a numeric
  // string. Filtering with the id as a string silently returns zero matches (no error, no
  // warning), which would have shipped as "donor has no donations/pledges/shifts" for every
  // donor. donorItemId isn't attacker-reachable today (it's derived from the session, never
  // client-supplied), but it still travels as a $donorItemId GraphQL variable rather than being
  // interpolated, as defense-in-depth and for consistency with findDonorsByEmail above.
  private async fetchItemsLinkedToDonor(
    boardId: number,
    linkColumnId: string,
    donorItemId: string,
    columnIds: string[],
    includeName: boolean,
    // Reading a board_relation column's linked_item_ids via the `... on BoardRelationValue`
    // fragment was verified in the same live check — the fragment shape itself was already
    // correct.
    includeLinkedItemIds = false,
    // Also the linked items' names (DTD "Matched By"); implies linked ids.
    includeLinkedItemNames = false
  ): Promise<MondayItem[]> {
    const relationFields = includeLinkedItemNames ? 'linked_item_ids linked_items { name }' : 'linked_item_ids';
    const valueFields =
      includeLinkedItemIds || includeLinkedItemNames ? `{ id text ... on BoardRelationValue { ${relationFields} } }` : '{ id text }';
    const itemFields = `id ${includeName ? 'name ' : ''}column_values(ids: ${JSON.stringify(columnIds)}) ${valueFields}`;
    const firstPageQuery = `
      query ($boardId: ID!, $donorItemId: CompareValue) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 500,
            query_params: {
              rules: [{ column_id: "${linkColumnId}", compare_value: [$donorItemId], operator: any_of }]
            }
          ) {
            cursor
            items { ${itemFields} }
          }
        }
      }
    `;
    const firstData = await this.request<{
      boards: { items_page: { cursor: string | null; items: MondayItem[] } }[];
    }>(firstPageQuery, { boardId, donorItemId: Number(donorItemId) });
    const firstPage = firstData.boards[0]?.items_page;
    return [...(firstPage?.items ?? []), ...(await this.remainingPages(firstPage?.cursor ?? null, `items { ${itemFields} }`))];
  }

  // True once all four DTD match columns hold real ids (mirrors matchLinesEnabled in config.ts,
  // which the client can't import a Config for); otherwise nothing match-related is requested.
  private matchLinesOn(): boolean {
    const c = this.columns;
    return [c.donationMatchesGift, c.donationMatchStatus, c.donationMatchedBy, c.donorDtdLink].every(
      (id) => id !== 'REPLACE_WITH_COLUMN_ID'
    );
  }

  // `awaitingDonor` indexes the records that get the DTD "Waiting for donor" hint once the caller
  // has the donor's DTD link (always empty with match lines off).
  private async getDonationsForDonor(donorItemId: string): Promise<{ records: DonationRecord[]; awaitingDonor: number[] }> {
    const matchLines = this.matchLinesOn();
    const columnIds = [
      this.columns.donationAmount,
      this.columns.donationDate,
      this.columns.donationDescription,
      this.columns.donationStatus,
    ];
    if (matchLines) {
      columnIds.push(this.columns.donationMatchesGift, this.columns.donationMatchStatus, this.columns.donationMatchedBy);
    }
    const items = await this.fetchItemsLinkedToDonor(
      this.donationsBoardId,
      this.columns.donationDonorLink,
      donorItemId,
      columnIds,
      false,
      false,
      matchLines
    );
    // Only countable statuses (strict: an item with a blank/unknown status is dropped too —
    // for money that ends up on a tax letter, "not provably received" means "doesn't count").
    // Then the history floor, applied the same strict way: an undated gift can't be shown to
    // be on or after the floor, so it's dropped whenever one is set.
    const countable = new Set(this.donations.countableStatuses);
    const floor = this.donations.historyStartISO;
    const kept = items
      .filter((item) => countable.has(columnText(item, this.columns.donationStatus)))
      .filter((item) => floor === null || columnText(item, this.columns.donationDate) >= floor);
    const records = kept.map((item): DonationRecord => ({
      amount: columnText(item, this.columns.donationAmount),
      date: columnText(item, this.columns.donationDate),
      description: columnText(item, this.columns.donationDescription),
    }));
    if (!matchLines) return { records, awaitingDonor: [] };

    // The donor's Matching Donation rows are already in `kept` (linked to the employee as Donor).
    // Each points at its original gift through Matches gift; attach the latest per gift, and only
    // when that gift is in this donor's list. Match rows stay listed and counted as before.
    const indexById = new Map(kept.map((item, i) => [item.id, i] as const));
    const matchRowIndexes = new Set<number>();
    kept.forEach((item, i) => {
      const column = (item.column_values ?? []).find((c) => c.id === this.columns.donationMatchesGift);
      const company = (item.column_values ?? []).find((c) => c.id === this.columns.donationMatchedBy)?.linked_items?.[0]?.name;
      const giftId = column?.linked_item_ids?.[0];
      if (giftId === undefined) return;
      matchRowIndexes.add(i);
      const target = indexById.get(giftId);
      if (target === undefined || !company) return;
      const record = records[target]!;
      const candidate = { date: records[i]!.date, amount: records[i]!.amount, company };
      if (!record.match || candidate.date > record.match.date) record.match = candidate;
    });
    const awaitingDonor: number[] = [];
    records.forEach((record, i) => {
      if (record.match || matchRowIndexes.has(i)) return;
      if (columnText(kept[i]!, this.columns.donationMatchStatus) === 'Waiting for donor') awaitingDonor.push(i);
    });
    return { records, awaitingDonor };
  }

  async getVolunteerShiftsForDonor(donorItemId: string): Promise<VolunteerShift[]> {
    // In-client defense mirroring the placeholder guards in findDonorsByEmail and
    // getMemberPortalData: routes.ts's volunteerHistoryEnabled gate is the intended entry
    // condition, but a future caller that misses it must fail loudly here rather than ship the
    // literal placeholder string (or a sentinel board id) to Monday's API.
    const volunteerColumns = [
      this.columns.volunteerDonorLink,
      this.columns.volunteerHours,
      this.columns.volunteerDate,
      this.columns.volunteerJob,
      this.columns.volunteerStatus,
    ];
    if (this.volunteersBoardId === null || volunteerColumns.some((id) => id === 'REPLACE_WITH_COLUMN_ID')) {
      throw new Error(
        'monday: volunteer history is not configured (monday.volunteersBoardId and every monday.columns.volunteer* id must be set) — gate calls with volunteerHistoryEnabled(config)'
      );
    }

    // Optional, so a missing or placeholder id drops the ticket type instead of failing the read.
    const ticketColumn = this.columns.volunteerTicketType;
    const ticketTypeId = ticketColumn !== undefined && ticketColumn !== 'REPLACE_WITH_COLUMN_ID' ? ticketColumn : null;

    const items = await this.fetchItemsLinkedToDonor(
      this.volunteersBoardId,
      this.columns.volunteerDonorLink,
      donorItemId,
      [
        this.columns.volunteerHours,
        this.columns.volunteerDate,
        this.columns.volunteerJob,
        this.columns.volunteerStatus,
        ...(ticketTypeId !== null ? [ticketTypeId] : []),
      ],
      false
    );
    return items.map((item) => ({
      hours: columnText(item, this.columns.volunteerHours),
      date: columnText(item, this.columns.volunteerDate),
      job: jobWithTicketType(
        columnText(item, this.columns.volunteerJob),
        ticketTypeId !== null ? columnText(item, ticketTypeId) : ''
      ),
      status: columnText(item, this.columns.volunteerStatus),
    }));
  }

  async getDonorNames(donorItemIds: string[]): Promise<{ id: string; name: string }[]> {
    if (donorItemIds.length === 0) return [];
    const query = `
      query ($itemIds: [ID!]) {
        items(ids: $itemIds) {
          id
          name
        }
      }
    `;
    const data = await this.request<{ items: MondayItem[] }>(query, { itemIds: donorItemIds });
    return (data.items ?? []).map((item) => ({ id: item.id, name: item.name }));
  }

  async getPledgesForDonor(donorItemId: string): Promise<PledgeRecord[]> {
    // Routes gate on pledgesEnabled before calling, so this only throws on a wiring bug —
    // loudly, rather than silently returning [] and rendering a misleading "no pledges" page.
    if (this.pledges === null) {
      throw new Error('monday: pledges board is not configured');
    }
    const { boardId, columns } = this.pledges;
    const items = await this.fetchItemsLinkedToDonor(
      boardId,
      columns.donorLink,
      donorItemId,
      [columns.pledgedAmount, columns.fulfilledAmount, columns.status, columns.dueDate],
      true
    );
    return items.map((item) => ({
      name: item.name,
      pledged: columnText(item, columns.pledgedAmount),
      fulfilled: columnText(item, columns.fulfilledAmount),
      status: columnText(item, columns.status),
      dueDate: columnText(item, columns.dueDate),
    }));
  }

  async getDiscountOrganizations(): Promise<DiscountOrganization[]> {
    // Verified live against the sandbox Organizations board on 2026-09-20: checkbox columns
    // don't support any_of/compare_value filtering at all — the API's own filter guidelines
    // (get_column_type_info) say checkbox only accepts is_empty/is_not_empty with an empty-array
    // compare_value. The original `{ compare_value: ["true"], operator: any_of }` shape ran
    // without error but silently matched nothing, which would have shipped as "no discount
    // organizations" regardless of how many were actually checked.
    const itemsSelection = `items { id name column_values(ids: ["${this.columns.discountOffered}"]) { id text } }`;
    const query = `
      query ($boardId: ID!) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 500,
            query_params: {
              rules: [{ column_id: "${this.columns.discountActive}", compare_value: [], operator: is_not_empty }]
            }
          ) {
            cursor
            ${itemsSelection}
          }
        }
      }
    `;
    const data = await this.request<{ boards: { items_page: { cursor: string | null; items: MondayItem[] } }[] }>(
      query,
      { boardId: this.organizationsBoardId }
    );
    const firstPage = data.boards[0]?.items_page;
    // Follow the cursor (issue GL#31): the first page alone silently dropped every active discount
    // past the 500th.
    const items = [...(firstPage?.items ?? []), ...(await this.remainingPages(firstPage?.cursor ?? null, itemsSelection))];
    return items.map((item) => ({
      name: item.name,
      discountOffered: columnText(item, this.columns.discountOffered),
    }));
  }

  async getDonorContactInfo(donorItemId: string): Promise<DonorContactInfo> {
    // preferredLanguage is a gated/optional column like membershipExpiry — join it onto the
    // otherwise-fixed donorEmail/donorAddress/donorPhone list only once configured, rather than
    // shipping the literal placeholder to Monday's API.
    const columnIds = [this.columns.donorEmail, this.columns.donorAddress, this.columns.donorPhone];
    if (this.columns.preferredLanguage !== 'REPLACE_WITH_COLUMN_ID') {
      columnIds.push(this.columns.preferredLanguage);
    }
    if (this.columns.donorEmployer !== 'REPLACE_WITH_COLUMN_ID') {
      columnIds.push(this.columns.donorEmployer);
    }
    const prefColumnIds = [this.columns.donorEmailOptOut, this.columns.donorSmsOptOut, this.columns.donorDoNotMail];
    for (const prefColumnId of prefColumnIds) {
      if (prefColumnId !== 'REPLACE_WITH_COLUMN_ID') {
        columnIds.push(prefColumnId);
      }
    }
    const query = `
      query ($itemId: ID!) {
        items(ids: [$itemId]) {
          id
          name
          column_values(ids: ${JSON.stringify(columnIds)}) {
            id
            text
          }
        }
      }
    `;
    const data = await this.request<{ items: MondayItem[] }>(query, { itemId: donorItemId });
    const item = data.items[0];
    if (!item) {
      throw new Error(`monday: donor item "${donorItemId}" not found`);
    }
    return {
      id: item.id,
      name: item.name,
      email: columnText(item, this.columns.donorEmail),
      address: columnText(item, this.columns.donorAddress),
      phone: columnText(item, this.columns.donorPhone),
      preferredLanguage: columnText(item, this.columns.preferredLanguage),
      employer: this.columns.donorEmployer === 'REPLACE_WITH_COLUMN_ID' ? '' : columnText(item, this.columns.donorEmployer),
      emailOptOut: checkboxState(item, this.columns.donorEmailOptOut),
      smsOptOut: checkboxState(item, this.columns.donorSmsOptOut),
      doNotMail: checkboxState(item, this.columns.donorDoNotMail),
    };
  }

  async getDonorEmails(donorItemId: string): Promise<DonorEmails> {
    // Household Email and both consent columns are gated: only requested once configured, so the
    // literal placeholder never ships to Monday's API, and read as '' until then.
    const configured = (columnId: string) => columnId !== 'REPLACE_WITH_COLUMN_ID';
    const optional = [this.columns.donorHouseholdEmail, this.columns.donorEmailConsent, this.columns.donorHouseholdEmailConsent];
    const columnIds = [this.columns.donorEmail, ...optional.filter(configured)];
    const query = `
      query ($itemId: ID!) {
        items(ids: [$itemId]) {
          id
          column_values(ids: ${JSON.stringify(columnIds)}) { id text value }
        }
      }
    `;
    const data = await this.request<{ items: MondayItem[] }>(query, { itemId: donorItemId });
    const item = data.items[0];
    if (!item) {
      throw new Error(`monday: donor item "${donorItemId}" not found`);
    }
    // columnEmail reads the address itself, not an email column's display label.
    const read = (columnId: string, value: (item: MondayItem, columnId: string) => string) =>
      configured(columnId) ? value(item, columnId).trim() : '';
    return {
      personal: read(this.columns.donorEmail, columnEmail),
      household: read(this.columns.donorHouseholdEmail, columnEmail),
      personalConsent: read(this.columns.donorEmailConsent, columnText),
      householdConsent: read(this.columns.donorHouseholdEmailConsent, columnText),
    };
  }

  async getEventRegistrationsForDonor(params: {
    donorItemId: string;
    boardId: number;
    columns: EventRegistrationColumns;
    eventDateColumnId: string;
  }): Promise<EventRegistrationRecord[]> {
    const { donorItemId, boardId, columns } = params;
    const registrations = await this.fetchItemsLinkedToDonor(
      boardId,
      columns.attendeeLink,
      donorItemId,
      [columns.attended, columns.eventLink],
      true,
      true
    );

    const linkedEventId = (item: MondayItem): string | null =>
      (item.column_values ?? []).find((c) => c.id === columns.eventLink)?.linked_item_ids?.[0] ?? null;

    const eventIds = [...new Set(registrations.map(linkedEventId).filter((id): id is string => id !== null))];
    const events = new Map<string, { name: string; date: string }>();
    if (eventIds.length > 0) {
      const eventsQuery = `
        query ($itemIds: [ID!]) {
          items(ids: $itemIds) {
            id
            name
            column_values(ids: ["${params.eventDateColumnId}"]) { id text }
          }
        }
      `;
      const eventsData = await this.request<{ items: MondayItem[] }>(eventsQuery, { itemIds: eventIds });
      for (const item of eventsData.items) {
        events.set(item.id, { name: item.name, date: columnText(item, params.eventDateColumnId) });
      }
    }

    return registrations.map((item) => {
      const event = events.get(linkedEventId(item) ?? '');
      return {
        registrationName: item.name,
        // NOTE: checkbox `text` is expected to be "v" when checked and ""/null when not — any
        // non-empty text counts as attended. Unverified against a live account, same caveat as
        // the query shapes above.
        eventName: event?.name ?? '',
        eventDate: event?.date ?? '',
        attended: columnText(item, columns.attended) !== '',
      };
    });
  }

  async findChangeRequestItem(params: { boardId: number; itemName: string }): Promise<string | null> {
    // items_page_by_column_values on "name" is an exact match (verified against the sandbox
    // boards on 2026-09-29: "Kalindi" does not match "Kalindi Fonda"); the equality filter below
    // keeps a looser match from ever adopting the wrong item regardless.
    const query = `
      query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!) {
        items_page_by_column_values(board_id: $boardId, columns: $columns) {
          items { id name }
        }
      }
    `;
    const data = await this.request<{ items_page_by_column_values: { items: MondayItem[] } }>(query, {
      boardId: params.boardId,
      columns: [{ column_id: 'name', column_values: [params.itemName] }],
    });
    return data.items_page_by_column_values.items.find((item) => item.name === params.itemName)?.id ?? null;
  }

  async findOrganizationsByNames(params: { boardId: number; names: string[] }): Promise<OrganizationCandidate[]> {
    if (params.names.length === 0) return [];
    // Exact match on name (see findChangeRequestItem); the caller compares normalised names.
    const query = `
      query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!) {
        items_page_by_column_values(board_id: $boardId, limit: 100, columns: $columns) {
          items { id name }
        }
      }
    `;
    const data = await this.request<{ items_page_by_column_values: { items: MondayItem[] } }>(query, {
      boardId: params.boardId,
      columns: [{ column_id: 'name', column_values: params.names }],
    });
    return data.items_page_by_column_values.items.map((item) => ({ id: item.id, name: item.name }));
  }

  // Through People's Affiliations link and items(ids:), not a board filter, so a retry sees an
  // affiliation an earlier, ambiguously failed create already linked.
  async getPersonAffiliations(params: { donorItemId: string; employer: EmployerAnswerConfig }): Promise<AffiliationRecord[]> {
    const { employer } = params;
    const linkQuery = `
      query ($itemId: ID!) {
        items(ids: [$itemId]) {
          id
          name
          state
          column_values(ids: ${JSON.stringify([employer.personAffiliationsLink])}) { id text ... on BoardRelationValue { linked_item_ids } }
        }
      }
    `;
    const linkData = await this.request<{ items: MondayItem[] }>(linkQuery, { itemId: Number(params.donorItemId) });
    // items(ids:) returns archived and deleted items too; only active ones count (as in donation-rollups).
    const person = linkData.items[0];
    if (!person || person.state !== 'active') throw new Error(`monday: donor item "${params.donorItemId}" not found`);
    const affiliationIds =
      (person.column_values ?? []).find((c) => c.id === employer.personAffiliationsLink)?.linked_item_ids ?? [];
    if (affiliationIds.length === 0) return [];

    const { organizationLink, status, primary } = employer.affiliationColumns;
    const portalColumn = this.portalAccessColumn();
    const query = `
      query ($itemIds: [ID!]) {
        items(ids: $itemIds, limit: 100) {
          id
          name
          state
          column_values(ids: ${JSON.stringify([organizationLink, status, primary, ...(portalColumn !== null ? [portalColumn] : [])])}) {
            id text ... on BoardRelationValue { linked_item_ids linked_items { name } }
          }
        }
      }
    `;
    const data = await this.request<{ items: MondayItem[] }>(query, { itemIds: affiliationIds.map(Number) });
    return data.items.filter((item) => item.state === 'active').map((item) => {
      const org = (item.column_values ?? []).find((c) => c.id === organizationLink);
      const statusText = columnText(item, status);
      return {
        id: item.id,
        organizationId: org?.linked_item_ids?.[0] ?? null,
        organizationName: org?.linked_items?.[0]?.name ?? null,
        statusLabel: statusText === '' ? null : statusText,
        primary: columnText(item, primary) !== '',
        portalAccess: portalColumn !== null && columnText(item, portalColumn) !== '',
      };
    });
  }

  async createAffiliation(params: {
    employer: EmployerAnswerConfig;
    itemName: string;
    donorItemId: string;
    organizationItemId: string;
  }): Promise<void> {
    const { affiliationColumns: cols, affiliationsBoardId, currentStatusLabel } = params.employer;
    const mutation = `
      mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id }
      }
    `;
    const columnValues = {
      [cols.personLink]: { item_ids: [Number(params.donorItemId)] },
      [cols.organizationLink]: { item_ids: [Number(params.organizationItemId)] },
      [cols.status]: { label: currentStatusLabel },
      [cols.primary]: { checked: 'true' },
    };
    // Not idempotent: the writer re-reads the person's affiliations before any retry creates.
    await this.request<{ create_item: { id: string } }>(
      mutation,
      { boardId: affiliationsBoardId, itemName: params.itemName, columnValues: JSON.stringify(columnValues) },
      { idempotent: false },
    );
  }

  async updateAffiliation(params: { employer: EmployerAnswerConfig; itemId: string; makeCurrent: boolean; primary: boolean }): Promise<void> {
    const { affiliationColumns: cols, affiliationsBoardId, currentStatusLabel } = params.employer;
    const mutation = `
      mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
      }
    `;
    // A null value clears a checkbox column; Status is only ever set, never cleared.
    const columnValues: Record<string, unknown> = {};
    if (params.makeCurrent) columnValues[cols.status] = { label: currentStatusLabel };
    columnValues[cols.primary] = params.primary ? { checked: 'true' } : null;
    await this.request<{ change_multiple_column_values: { id: string } }>(mutation, {
      boardId: affiliationsBoardId,
      itemId: Number(params.itemId),
      columnValues: JSON.stringify(columnValues),
    });
  }

  async createChangeRequestItem(params: {
    boardId: number;
    columns: ChangeRequestColumns;
    itemName: string;
    donorItemId: string;
    fieldLabel: string;
    oldValue: string;
    newValue: string;
    submittedAtISO: string;
  }): Promise<void> {
    // column_values shapes (connect-boards { item_ids }, date { date, time }) verified live
    // against the sandbox Change Requests board on 2026-09-20 — donor link resolved correctly,
    // text/date columns round-tripped as expected, item landed in the top ("New") group. All
    // user-sourced values travel as GraphQL variables.
    const mutation = `
      mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
          id
        }
      }
    `;
    const columnValues: Record<string, unknown> = {
      [params.columns.donorLink]: { item_ids: [Number(params.donorItemId)] },
      [params.columns.field]: params.fieldLabel,
      [params.columns.oldValue]: params.oldValue,
      [params.columns.newValue]: params.newValue,
      [params.columns.submittedAt]: {
        date: params.submittedAtISO.slice(0, 10),
        time: params.submittedAtISO.slice(11, 19),
      },
    };
    // Not idempotent: a create that may have committed throws AmbiguousWriteError rather than
    // being retried in-process. The consumer (changeRequests/processBatch.ts) looks the item up by
    // name before every create, so its queue retry adopts an item that did land instead of
    // leaving staff a duplicate.
    await this.request<{ create_item: { id: string } }>(
      mutation,
      { boardId: params.boardId, itemName: params.itemName, columnValues: JSON.stringify(columnValues) },
      { idempotent: false },
    );
  }

  async getLetterSettings(params: {
    boardId: number;
    columns: LetterCronColumns;
    settingsItemName: string;
  }): Promise<LetterSettings | null> {
    // The Letter Settings board holds a single staff-edited item, named by config
    // letterCron.settingsItemName ("Letter emails" — created by
    // scripts/create-letter-settings-board.mjs, which reads the same config key). Only that
    // exact item is read: Monday's board-creation template seeds default items ("Task 1") that
    // sort ahead of the real settings item (a failure observed live on the sandbox board), and
    // runLetterCron gates automated sending on this item's autoSend — so a renamed item or a
    // hand-recreated board must throw loudly rather than silently arm/disarm the letter run
    // from an arbitrary item. An empty board still returns null ("not seeded yet").
    // Checkbox state comes from the CheckboxValue fragment's `checked` field rather than the
    // display text — Monday renders an unchecked box as null text and a checked one as "v",
    // neither of which is worth string-matching on.
    const localeColumnEntries = Object.entries(params.columns.bodyTemplatesByLocale) as [Locale, string][];
    const columnIds = [
      params.columns.autoSend,
      params.columns.startDate,
      params.columns.bodyTemplate,
      ...localeColumnEntries.map(([, columnId]) => columnId),
    ];
    const query = `
      query ($boardId: ID!) {
        boards(ids: [$boardId]) {
          items_page(limit: 25) {
            items {
              id
              name
              column_values(ids: ${JSON.stringify(columnIds)}) {
                id
                text
                ... on CheckboxValue { checked }
              }
            }
          }
        }
      }
    `;
    const data = await this.request<{ boards: { items_page: { items: MondayItem[] } }[] }>(query, {
      boardId: params.boardId,
    });
    const items = data.boards[0]?.items_page.items ?? [];
    if (items.length === 0) return null;
    const item = items.find((i) => i.name === params.settingsItemName);
    if (!item) {
      throw new Error(
        `monday: Letter Settings board ${params.boardId} has no item named "${params.settingsItemName}" ` +
          `(items present: ${items.map((i) => `"${i.name}"`).join(', ')}) — rename the settings item ` +
          'or update letterCron.settingsItemName in config'
      );
    }
    const autoSendValue = (item.column_values ?? []).find((c) => c.id === params.columns.autoSend);
    const bodyTemplatesByLocale: Partial<Record<Locale, string>> = {};
    for (const [locale, columnId] of localeColumnEntries) {
      const text = columnText(item, columnId);
      if (text.trim().length > 0) {
        bodyTemplatesByLocale[locale] = text;
      }
    }
    return {
      autoSend: autoSendValue?.checked === true,
      startDate: columnText(item, params.columns.startDate),
      bodyTemplate: columnText(item, params.columns.bodyTemplate),
      bodyTemplatesByLocale,
    };
  }

  // ---- Organization reps (spec 2026-11-19-member-portal-organization-reps-design.md) ----
  // GraphQL shapes here follow the ones this file already uses live. items(ids:) with `board { id }`,
  // linked_items { id board { id } } and the Work Email column filter were all verified live
  // against the sandbox on 2026-11-19.

  // Null while the Portal access column is unconfigured: it is never requested and reads false.
  private portalAccessColumn(): string | null {
    const id = this.orgs?.organizations.portalAccessColumn;
    return id !== undefined && id !== 'REPLACE_WITH_COLUMN_ID' ? id : null;
  }

  private workEmailColumn(): string | null {
    const id = this.orgs?.organizations.workEmailColumn;
    return id !== undefined && id !== 'REPLACE_WITH_COLUMN_ID' ? id : null;
  }

  private affiliationsConfig(): EmployerAnswerConfig {
    const employer = this.orgs?.employer ?? null;
    if (employer === null) {
      throw new Error('monday: organization affiliations are not configured (changeRequests.employer) — gate calls with orgAccessEnabled(config)');
    }
    return employer;
  }

  private affiliationColumnIds(): string[] {
    const { personLink, organizationLink, status } = this.affiliationsConfig().affiliationColumns;
    const ids = [personLink, organizationLink, status];
    const portal = this.portalAccessColumn();
    const workEmail = this.workEmailColumn();
    if (portal !== null) ids.push(portal);
    if (workEmail !== null) ids.push(workEmail);
    return ids;
  }

  private toOrgAffiliation(item: MondayItem): OrgAffiliation {
    const { personLink, organizationLink, status } = this.affiliationsConfig().affiliationColumns;
    const portal = this.portalAccessColumn();
    const workEmail = this.workEmailColumn();
    const linked = (columnId: string) => (item.column_values ?? []).find((c) => c.id === columnId)?.linked_item_ids?.[0] ?? null;
    const statusText = columnText(item, status);
    return {
      id: item.id,
      personItemId: linked(personLink),
      organizationId: linked(organizationLink),
      statusLabel: statusText === '' ? null : statusText,
      portalAccess: portal !== null && columnText(item, portal) !== '',
      workEmail: workEmail !== null ? columnEmail(item, workEmail) : '',
    };
  }

  async findAffiliationsByWorkEmail(email: string): Promise<OrgAffiliation[]> {
    const workEmail = this.workEmailColumn();
    if (workEmail === null) return [];
    const employer = this.affiliationsConfig();
    // As findDonorsByEmail: the address is attacker-controlled, so it travels as a CompareValue
    // variable, and Monday's filter is re-checked exactly below.
    const query = `
      query ($boardId: ID!, $email: CompareValue) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 25,
            query_params: {
              rules: [{ column_id: "${workEmail}", compare_value: [$email], operator: any_of }]
            }
          ) {
            items { id state column_values(ids: ${JSON.stringify(this.affiliationColumnIds())}) { id text value ... on BoardRelationValue { linked_item_ids } } }
          }
        }
      }
    `;
    const data = await this.request<{ boards: { items_page: { items: MondayItem[] } }[] }>(query, {
      boardId: employer.affiliationsBoardId,
      email,
    });
    const wanted = email.trim().toLowerCase();
    return (data.boards[0]?.items_page.items ?? [])
      .filter((item) => item.state === undefined || item.state === 'active')
      .map((item) => this.toOrgAffiliation(item))
      .filter((aff) => aff.workEmail.trim().toLowerCase() === wanted);
  }

  async getAffiliation(affiliationItemId: string): Promise<OrgAffiliation | null> {
    const employer = this.affiliationsConfig();
    const query = `
      query ($itemId: ID!) {
        items(ids: [$itemId]) {
          id
          state
          board { id }
          column_values(ids: ${JSON.stringify(this.affiliationColumnIds())}) { id text value ... on BoardRelationValue { linked_item_ids } }
        }
      }
    `;
    const data = await this.request<{ items: MondayItem[] }>(query, { itemId: Number(affiliationItemId) });
    const item = data.items[0];
    // items(ids:) returns archived and deleted items too, and items on any board: an id from
    // another board must never read as an Affiliation (the live organization access check).
    if (!item || item.state !== 'active' || String(item.board?.id) !== String(employer.affiliationsBoardId)) return null;
    return this.toOrgAffiliation(item);
  }

  async getOrganizationAffiliations(orgItemId: string): Promise<OrgAffiliation[]> {
    const employer = this.affiliationsConfig();
    // items_page lists only active items, so archived Affiliations never come back (as with
    // every other fetchItemsLinkedToDonor read); the state filter is a backstop where it is present.
    const items = await this.fetchItemsLinkedToDonor(
      employer.affiliationsBoardId,
      employer.affiliationColumns.organizationLink,
      orgItemId,
      this.affiliationColumnIds(),
      false,
      true
    );
    return items.filter((item) => item.state === undefined || item.state === 'active').map((item) => this.toOrgAffiliation(item));
  }

  async getOrganization(orgItemId: string): Promise<{ id: string; name: string; address: string } | null> {
    // An empty list, or any placeholder in it, means no address line: nothing is requested.
    const addressColumns = this.orgs?.organizations.addressColumns ?? [];
    const addressOn = addressColumns.length > 0 && addressColumns.every((id) => id !== 'REPLACE_WITH_COLUMN_ID');
    const columnSelection = addressOn ? `column_values(ids: ${JSON.stringify(addressColumns)}) { id text }` : '';
    const query = `
      query ($itemId: ID!) {
        items(ids: [$itemId]) {
          id
          name
          state
          board { id }
          ${columnSelection}
        }
      }
    `;
    const data = await this.request<{ items: MondayItem[] }>(query, { itemId: Number(orgItemId) });
    const item = data.items[0];
    // items(ids:) answers for any item on any board, archived or not: a person's item id must
    // never resolve as an organization.
    if (!item || item.state !== 'active' || String(item.board?.id) !== String(this.organizationsBoardId)) return null;
    const address = addressOn
      ? addressColumns
          .map((id) => columnText(item, id).trim())
          .filter((part) => part !== '')
          .join(', ')
      : '';
    return { id: item.id, name: item.name, address };
  }

  // Donations linked to an organization through `linkColumnId`, under getDonationsForDonor's
  // countable-status and history-floor rules.
  private async getLinkedGifts(orgItemId: string, linkColumnId: string): Promise<OrgGift[]> {
    const items = await this.fetchItemsLinkedToDonor(
      this.donationsBoardId,
      linkColumnId,
      orgItemId,
      [this.columns.donationAmount, this.columns.donationDate, this.columns.donationDescription, this.columns.donationStatus],
      true
    );
    const countable = new Set(this.donations.countableStatuses);
    const floor = this.donations.historyStartISO;
    return items
      .filter((item) => countable.has(columnText(item, this.columns.donationStatus)))
      .filter((item) => floor === null || columnText(item, this.columns.donationDate) >= floor)
      .map((item) => ({
        itemId: item.id,
        date: columnText(item, this.columns.donationDate),
        amount: columnText(item, this.columns.donationAmount),
        giftType: columnText(item, this.columns.donationDescription),
      }));
  }

  async getOrganizationGifts(orgItemId: string): Promise<OrgGift[]> {
    return this.getLinkedGifts(orgItemId, this.columns.donationDonorLink);
  }

  async getOrganizationMatches(orgItemId: string): Promise<OrgGift[]> {
    // Gated on Matched By alone, not the four-column match-line set.
    if (this.columns.donationMatchedBy === 'REPLACE_WITH_COLUMN_ID') return [];
    return this.getLinkedGifts(orgItemId, this.columns.donationMatchedBy);
  }

  // Every item on `boardId` dated within `year`, across pages. `columnValuesSelection` is the
  // `column_values(...) { ... }` part of the item selection. The date-column `between` rules shape
  // was verified live on 2026-08-25 against the sandbox Donations board (18427756119); callers
  // keep a client-side year check as a correctness backstop regardless.
  private async sweepYear(boardId: number, dateColumnId: string, year: number, columnValuesSelection: string): Promise<MondayItem[]> {
    const itemFields = `items { id ${columnValuesSelection} }`;
    const firstPageQuery = `
      query ($boardId: ID!, $from: String!, $to: String!) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 500,
            query_params: {
              rules: [{ column_id: "${dateColumnId}", compare_value: [$from, $to], operator: between }]
            }
          ) {
            cursor
            ${itemFields}
          }
        }
      }
    `;
    const firstData = await this.request<{
      boards: { items_page: { cursor: string | null; items: MondayItem[] } }[];
    }>(firstPageQuery, { boardId, from: `${year}-01-01`, to: `${year}-12-31` });
    const firstPage = firstData.boards[0]?.items_page;
    return [...(firstPage?.items ?? []), ...(await this.remainingPages(firstPage?.cursor ?? null, itemFields))];
  }

  async getCompletedVolunteerHoursInYear(year: number): Promise<Map<string, number>> {
    const volunteerColumns = [
      this.columns.volunteerDonorLink,
      this.columns.volunteerHours,
      this.columns.volunteerDate,
      this.columns.volunteerStatus,
    ];
    if (this.volunteersBoardId === null || volunteerColumns.some((id) => id === 'REPLACE_WITH_COLUMN_ID')) {
      throw new Error('monday: volunteer hours are not configured (monday.volunteersBoardId and every monday.columns.volunteer* id must be set)');
    }
    const items = await this.sweepYear(
      this.volunteersBoardId,
      this.columns.volunteerDate,
      year,
      `column_values(ids: ${JSON.stringify(volunteerColumns)}) { id text ... on BoardRelationValue { linked_item_ids } }`
    );
    // An empty completedStatuses means every status counts, as for the donor's own history.
    const completed = this.orgs?.volunteerCompletedStatuses ?? [];
    const hours = new Map<string, number>();
    for (const item of items) {
      if (!columnText(item, this.columns.volunteerDate).startsWith(`${year}-`)) continue;
      if (completed.length > 0 && !completed.includes(columnText(item, this.columns.volunteerStatus))) continue;
      const shiftHours = parseAmountOrNull(columnText(item, this.columns.volunteerHours));
      if (shiftHours === null) continue;
      const link = (item.column_values ?? []).find((c) => c.id === this.columns.volunteerDonorLink);
      for (const personId of link?.linked_item_ids ?? []) {
        hours.set(personId, (hours.get(personId) ?? 0) + shiftHours);
      }
    }
    return hours;
  }

  async listYearActivity(year: number, excludedGiftTypes: string[]): Promise<{ personIds: string[]; organizationIds: string[] }> {
    // Backs the January letter cron: one sweep of the Donations board bounded to the target year,
    // instead of a getMemberPortalData call per Donors-board item. The Donor link also reads each
    // linked item's board, so organizations (which the letter run must not treat as people) split
    // off from donors. Only Donors-board ids count as people.
    const matchedBy = this.columns.donationMatchedBy !== 'REPLACE_WITH_COLUMN_ID' ? this.columns.donationMatchedBy : null;
    const columnIds = [
      this.columns.donationDate,
      this.columns.donationDonorLink,
      this.columns.donationStatus,
      this.columns.donationDescription,
      ...(matchedBy !== null ? [matchedBy] : []),
    ];
    const allItems = await this.sweepYear(
      this.donationsBoardId,
      this.columns.donationDate,
      year,
      `column_values(ids: ${JSON.stringify(columnIds)}) { id text ... on BoardRelationValue { linked_item_ids linked_items { id board { id } } } }`
    );

    const personIds = new Set<string>();
    const organizationIds = new Set<string>();
    // Same status filter as getDonationsForDonor: a donor whose only gifts in the year are
    // Failed/Pending must not be swept into the letter run.
    const countable = new Set(this.donations.countableStatuses);
    const floor = this.donations.historyStartISO;
    const orgBoardId = String(this.organizationsBoardId);
    const donorsBoardId = String(this.donorsBoardId);
    let dropped = 0;
    for (const item of allItems) {
      const date = columnText(item, this.columns.donationDate);
      if (!date.startsWith(`${year}-`)) continue;
      // Same floor as getDonationsForDonor, so a mid-year floor can't earn a letter for gifts
      // the donor's own letter page would omit.
      if (floor !== null && date < floor) continue;
      if (!countable.has(columnText(item, this.columns.donationStatus))) continue;
      const link = (item.column_values ?? []).find((c) => c.id === this.columns.donationDonorLink);
      // Same Gift Type rule as loadLetterData (donationDescription is the Gift Type column), for
      // people only: an organization's excluded-type gift (a sponsorship) still counts as activity.
      const excluded = giftTypeIn(excludedGiftTypes, columnText(item, this.columns.donationDescription));
      // Classified by the linked item's own board, from linked_items (a link whose item is
      // deleted or inaccessible has an id but no board entry). Only the Donors board counts as
      // people, so an organization id can never enter the person letter run; anything else
      // (no board info, Historical People, other boards) is dropped.
      for (const linked of link?.linked_items ?? []) {
        const boardId = linked.board?.id === undefined ? null : String(linked.board.id);
        if (linked.id === undefined || boardId === null) dropped++;
        else if (boardId === orgBoardId) organizationIds.add(linked.id);
        else if (boardId === donorsBoardId) {
          if (!excluded) personIds.add(linked.id);
        } else dropped++;
      }
      if (matchedBy !== null) {
        const matched = (item.column_values ?? []).find((c) => c.id === matchedBy);
        for (const orgId of matched?.linked_item_ids ?? []) organizationIds.add(orgId);
      }
    }
    if (dropped > 0) console.warn(`member-portal year sweep skipped ${dropped} linked donor(s) not on the Donors or Organizations board`);
    return { personIds: [...personIds], organizationIds: [...organizationIds] };
  }
}
