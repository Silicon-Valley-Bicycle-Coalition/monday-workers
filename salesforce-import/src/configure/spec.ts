import type { DashboardSpec } from './dashboards.js';
import type { WidgetSpec } from './widgets.js';
import { STAKEHOLDER_TYPE_LABELS } from '../load/boards.js';
// The board-configuration spec derived from docs/22-board-configuration-plan.md §3 (private
// planning repo). Keyed by the same board keys as config/svbc.json's monday.boards / the
// load-time board map (data/load/boards.json) — NOT docs/22's own board ids, which belonged to
// boards that have since been rebuilt with new ids.
//
// Deliberately out of scope here (left as manual steps — see README "configure" section):
// * Automations — monday.com has no public create_automation mutation; docs/22 §2.9 itself
//   already treats the automation description field as UI-only.
// * The "Documentation" doc view — no API creates a doc-kind view or writes doc content.
// * Stripping Monday's stock status labels — docs/22 §2.5 recommends the UI for this itself
//   ("safer" on a column that may carry data); not scripted here.
// * Deleting the Subitems columns, hiding plumbing columns in the default view, Chart/Kanban/
//   Calendar views, and the Acknowledgment Tier backfill — all explicitly UI-only or one-off
//   data operations in docs/22, not board-configuration structure.
// * The Donations numeric "Fiscal Year" column removal — a guarded one-off delete with its own
//   precondition check, not a repeatable structural step; do it by hand per docs/22 §3.4.
// * Annual Giving Summary — written by the donation-rollups Worker, not part of this board map.

export interface ColumnSpec {
  title: string;
  type: 'status' | 'dropdown' | 'tags' | 'text' | 'checkbox' | 'numbers' | 'people';
  labels?: string[]; // status/dropdown only, in display order
}

export interface FilterRule {
  columnTitle: string;
  // any_of | not_any_of | is_empty | is_not_empty | contains_text | greater_than | between | ... |
  // within_the_next / within_the_last (relative date; compareValue ['DAYS' | 'MONTHS', n]).
  // Widgets only: labelValues may hold '@FY' / '@FY-1', and a date rule's compareValue may be
  // { fiscalYear: 'current' | 'previous' } (resolved at apply time from the clock, fiscal.ts).
  operator: string;
  labelValues?: string[]; // resolved to label ids at apply time (status/dropdown columns)
  compareValue?: unknown; // literal compare value for non-label columns; default [] when omitted
}

export type ViewTag = 'Worklist' | 'Report' | 'Reference';

// One colour language across boards: red needs action, amber coming due, green good standing,
// grey historical.
export interface ColoringRule {
  columnTitle: string;
  operator?: 'any_of' | 'is_empty' | 'is_not_empty' | 'greater_than' | 'lower_than' | 'between' | 'within_the_next';
  labelValues?: string[]; // status/dropdown; resolved to label ids like filter rules
  compareValue?: unknown; // non-label columns; within_the_next takes ['DAYS', 60]
  color: 'red' | 'amber' | 'green' | 'grey';
  entireRow?: boolean; // default true
}

export interface ViewSpec {
  name: string;
  filter?: { operator?: 'and' | 'or'; rules: FilterRule[] };
  sort?: { columnTitle: string; direction?: 'asc' | 'desc' }[];
  columns?: string[]; // visible, in order, after Name; every other column is hidden
  groupBy?: { columnTitle: string; direction?: 'asc' | 'desc' };
  coloring?: ColoringRule[];
  tag?: ViewTag;
}

export interface BoardSpec {
  description: string;
  groupTitle: string;
  columns?: ColumnSpec[];
  columnDescriptions?: Record<string, string>;
  views?: ViewSpec[];
  deleteStrayViews?: string[];
}

const DOC = (path: string) => `https://bikesiliconvalley.monday.com/docs/${path}`;

// Shared column descriptions from docs/22 §2.7, reused verbatim wherever the column appears.
const SHARED_DESCRIPTIONS = {
  'Salesforce Debug': 'Provenance from the migration (Salesforce IDs and raw values), kept for ' +
    'cutover reconciliation. Not a day-to-day field; deleted after the migration.',
  'Salesforce Owner': "Name of the Salesforce record owner at migration, for reconciliation. " +
    'Not a Monday people column and not maintained.',
  'Lat': 'Geocoded from Address at migration. Used by the advocacy geography scripts; not meant to be edited.',
  'Lng': 'Geocoded from Address at migration. Used by the advocacy geography scripts; not meant to be edited.',
  'Do Not Solicit': 'Suppress solicitations to this record. Requires a Do Not Solicit Reason — ' +
    'DNS Reason Status flags a missing one.',
  'Do Not Solicit Reason': 'Why this record is not to be solicited. Required whenever Do Not Solicit is checked.',
} as const;
// People boards only — Organizations has no Do Not Mail.
const POSTAL_DESCRIPTIONS = {
  'Do Not Mail': 'Leave this person off postal mailings. Email consent is separate (the Consent columns).',
  'Do Not Mail Reason': 'Opt out all mail, or Undeliverable (the address needs fixing).',
} as const;
// People boards only. Windfall wealth screening, loaded once from Salesforce (monday-migration
// docs/09); SVBC's subscription has ended, so nothing refreshes these.
const WINDFALL_FROZEN = 'From Windfall wealth screening, frozen at migration — the subscription has ended and nothing updates it.';
const WINDFALL_DESCRIPTIONS = {
  'Net Worth': `Windfall's estimated net worth. ${WINDFALL_FROZEN}`,
  'Net Worth Low': `Lower bound of Windfall's net-worth estimate. ${WINDFALL_FROZEN}`,
  'Net Worth High': `Upper bound of Windfall's net-worth estimate. ${WINDFALL_FROZEN}`,
  'Net Worth Date': `When Windfall last calculated Net Worth. ${WINDFALL_FROZEN}`,
  'Philanthropic Giver': `Windfall found charitable giving elsewhere. ${WINDFALL_FROZEN}`,
  'Job Title': `Windfall's employment match. ${WINDFALL_FROZEN} Structured employment lives on Affiliations.`,
  'Windfall Company': `Windfall's employment match; may differ from Employer Name. ${WINDFALL_FROZEN}`,
  'LinkedIn': `Windfall's LinkedIn match. ${WINDFALL_FROZEN}`,
  'Windfall ID': `The person's record in Windfall. ${WINDFALL_FROZEN}`,
  'Windfall Priority': "Salesforce's Windfall Priority Score at migration: 1, plus 50 if Net Worth tops $10M, " +
    'plus gifts closed in the prior year. Frozen; for current giving use the rollup columns.',
  'Windfall Profile': `Remaining Windfall detail (employment, giving focus, property and life-event flags). ${WINDFALL_FROZEN}`,
} as const;
const ROLLUP_DESCRIPTION = 'Computed automatically from Donations by the donation-rollups integration. Edits are overwritten.';
const DONOR_LEVEL_DESCRIPTION = 'Leadership ($5,000+ lifetime), Major ($500+ lifetime or a single gift of $200+), or Donor. ' +
  ROLLUP_DESCRIPTION;
const NIGHTLY_CLASSIFY = 'Set nightly by the donation-rollups integration from Gift Type, Amount, and Date. Edits are overwritten.';
const DNS_REASON_STATUS_DESC = "Missing means Do Not Solicit is checked with no reason recorded. " +
  "Maintained by automation; review the 'DNS reason missing' view.";

const DNS_COLUMN: ColumnSpec = { title: 'DNS Reason Status', type: 'status', labels: ['OK', 'Missing'] };

// Hidden from every working view (spec 2026-09-29 §3.2); still on the board and in Main Table.
export const PLUMBING = [
  'Salesforce Debug', 'Salesforce Owner', 'Lat', 'Lng', 'Gift Ledger (JSON)', 'Funraise ID',
  'Funraise Event ID', 'Eventbrite ID', 'Eventbrite Attendee ID', 'Benevity Transaction ID',
  'Eventbrite Order ID', 'Windfall ID',
] as const;

const dnsViews = (contactColumn: string): ViewSpec[] => [
  { name: 'Do Not Solicit', tag: 'Reference', columns: [contactColumn, 'Do Not Solicit Reason', 'DNS Reason Status'],
    filter: { rules: [{ columnTitle: 'Do Not Solicit', operator: 'is_not_empty' }] } },
  { name: 'DNS reason missing', tag: 'Worklist', columns: ['Do Not Solicit Reason', 'DNS Reason Status', contactColumn],
    filter: { rules: [{ columnTitle: 'DNS Reason Status', operator: 'any_of', labelValues: ['Missing'] }] },
    coloring: [{ columnTitle: 'DNS Reason Status', labelValues: ['Missing'], color: 'red' }] },
];
const DNS_VIEWS = dnsViews('Personal Email');
// Organizations has no Personal Email.
const ORG_DNS_VIEWS = dnsViews('Website');
const NOT_DNS = { columnTitle: 'Do Not Solicit', operator: 'is_empty' } as const;

export const BOARD_SPECS: Record<string, BoardSpec> = {
  'people-live': {
    description: 'Individual donors, members, and other real-relationship contacts with activity ' +
      'since about 2019. A person is always a separate item from any organization they’re ' +
      `linked to (see Organizations and Affiliations). Process overview & how-to: ${DOC('46299435')}`,
    groupTitle: 'People',
    columns: [
      // Normally already created by load (transform seeds Elected Official — see people.ts); this
      // entry only matters for a board loaded with no elected contact in the run.
      { title: 'Stakeholder Type', type: 'status', labels: [...STAKEHOLDER_TYPE_LABELS] },
      { title: 'Campaign', type: 'tags' },
      DNS_COLUMN,
    ],
    columnDescriptions: {
      ...SHARED_DESCRIPTIONS, ...POSTAL_DESCRIPTIONS, ...WINDFALL_DESCRIPTIONS,
      'Personal Email': "The person's own address. Email consent for this address is in Personal Email Consent.",
      'Household Email': 'A shared household address, possibly used by more than one person. Its ' +
        'consent is tracked separately in Household Email Consent.',
      'Personal Email Consent': 'Mailchimp subscription state for that address, loaded from ' +
        'Mailchimp (the consent system of record), not Salesforce. Consent belongs to the ' +
        'address, so the two columns can differ.',
      'Household Email Consent': 'Mailchimp subscription state for that address, loaded from ' +
        'Mailchimp (the consent system of record), not Salesforce. Consent belongs to the ' +
        'address, so the two columns can differ.',
      'Membership Status': 'Active or Lapsed; blank for people who have never been members. ' +
        'Flips to Lapsed automatically when Member Until passes.',
      'Membership Tier': 'Member, or Lifetime for lifetime members. Salesforce held no ' +
        'membership levels, so this launches flat.',
      'Member Since': 'Current membership term. Each membership payment on Donations carries its own Term Start / Term End.',
      'Member Until': 'Current membership term. Each membership payment on Donations carries its own Term Start / Term End.',
      'Organization': 'Organizations this person is affiliated with. Tenure, role, and work ' +
        'email for each are on the Affiliations board.',
      'Employer Name': 'Free text from Salesforce. Structured employment lives on Affiliations.',
      'Stakeholder Type': 'Advocacy classification. City or Agency Staff and Elected Official ' +
        'link to their municipal organization via Organization.',
      'Campaign': 'Which outreach pushes this person was loaded or tagged into (replaces ' +
        'Salesforce Campaign Membership for new bulk loads — see the Process Overview doc).',
      'DNS Reason Status': DNS_REASON_STATUS_DESC,
      'Funraise Profile': "The donor's supporter record in Funraise.",
      'Lifetime Giving': ROLLUP_DESCRIPTION, 'First Gift': ROLLUP_DESCRIPTION, 'Gift Count': ROLLUP_DESCRIPTION,
      'Donor Level': DONOR_LEVEL_DESCRIPTION,
    },
    views: [
      { name: 'Find a person', tag: 'Reference',
        columns: ['Personal Email', 'Phone', 'City', 'Organization', 'Membership Status', 'Donor Level'],
        sort: [{ columnTitle: 'Name' }] },
      { name: 'Donors', tag: 'Report',
        columns: ['Personal Email', 'City', 'Lifetime Giving', 'Last Gift Date', 'Last Gift Amount', 'This Year Amount', 'Membership Status'],
        groupBy: { columnTitle: 'Donor Level' }, sort: [{ columnTitle: 'Lifetime Giving', direction: 'desc' }],
        filter: { rules: [{ columnTitle: 'Gift Count', operator: 'greater_than', compareValue: 0 }] } },
      { name: 'Major donors', tag: 'Report',
        columns: ['Donor Level', 'Personal Email', 'Phone', 'Address', 'City', 'Lifetime Giving', 'Largest Gift', 'Last Gift Date', 'Member Until'],
        filter: { rules: [{ columnTitle: 'Donor Level', operator: 'any_of', labelValues: ['Leadership', 'Major'] }, NOT_DNS] },
        sort: [{ columnTitle: 'Lifetime Giving', direction: 'desc' }] },
      { name: 'Donors to target', tag: 'Worklist',
        columns: ['Personal Email', 'Phone', 'City', 'Last Gift Amount', 'Last Gift Date', 'Lifetime Giving'],
        filter: { rules: [{ columnTitle: 'Last Gift Amount', operator: 'greater_than', compareValue: 249.99 }, NOT_DNS] },
        sort: [{ columnTitle: 'Last Gift Date', direction: 'desc' }] },
      { name: 'Gave last year, not this year', tag: 'Worklist',
        columns: ['Personal Email', 'Phone', 'Last Year Amount', 'Last Gift Date', 'Lifetime Giving', 'Donor Level'],
        filter: { rules: [{ columnTitle: 'Last Year Amount', operator: 'greater_than', compareValue: 0 },
          { columnTitle: 'This Year Count', operator: 'lower_than', compareValue: 1 }, NOT_DNS] },
        sort: [{ columnTitle: 'Last Year Amount', direction: 'desc' }] },
      { name: 'Appeal list', tag: 'Report',
        columns: ['Personal Email', 'Address', 'City', 'Zip', 'Last Gift Date', 'Lifetime Giving'],
        filter: { rules: [{ columnTitle: 'Gift Count', operator: 'greater_than', compareValue: 0 },
          { columnTitle: 'Personal Email', operator: 'is_not_empty' }, NOT_DNS] },
        groupBy: { columnTitle: 'Donor Level' } },
      // Replaces the Salesforce Winter Appeal pulls (monday-migration docs/32 §3.1): gave in the
      // last five years, single gift of $25 or more. Recurring donors aren't excluded — People has
      // no recurring-gift flag; check Recurring Gifts › Active by hand.
      { name: 'Postal appeal list', tag: 'Report',
        columns: ['Address', 'City', 'Zip', 'Last Gift Date', 'Largest Gift', 'Lifetime Giving'],
        filter: { rules: [{ columnTitle: 'Gift Count', operator: 'greater_than', compareValue: 0 },
          { columnTitle: 'Address', operator: 'is_not_empty' },
          { columnTitle: 'Largest Gift', operator: 'greater_than', compareValue: 24.99 },
          { columnTitle: 'Last Gift Date', operator: 'within_the_last', compareValue: ['MONTHS', 60] },
          NOT_DNS, { columnTitle: 'Do Not Mail', operator: 'is_empty' }] },
        groupBy: { columnTitle: 'Donor Level' } },
      { name: 'Members', tag: 'Report',
        columns: ['Personal Email', 'Membership Status', 'Membership Tier', 'Member Since', 'Member Until', 'City'],
        filter: { rules: [{ columnTitle: 'Membership Status', operator: 'is_not_empty' }] },
        sort: [{ columnTitle: 'Member Until' }],
        coloring: [
          { columnTitle: 'Member Until', operator: 'within_the_next', compareValue: ['DAYS', 60], color: 'amber' },
          { columnTitle: 'Membership Status', labelValues: ['Lapsed'], color: 'red' },
        ] },
      { name: 'Active members', tag: 'Reference',
        columns: ['Personal Email', 'Household Email', 'Membership Tier', 'Member Since', 'Member Until'],
        filter: { rules: [{ columnTitle: 'Membership Status', operator: 'any_of', labelValues: ['Active'] }] }, sort: [{ columnTitle: 'Name' }] },
      { name: 'By city', tag: 'Report', columns: ['City', 'Zip', 'Personal Email', 'Membership Status', 'Donor Level'],
        groupBy: { columnTitle: 'City' } },
      { name: 'Stakeholders', tag: 'Reference', columns: ['Stakeholder Type', 'Organization', 'City', 'Zip', 'Personal Email'],
        filter: { rules: [{ columnTitle: 'Stakeholder Type', operator: 'any_of', labelValues: ['City or Agency Staff', 'Elected Official'] }] } },
      { name: 'Wealth screening', tag: 'Report',
        columns: ['Net Worth', 'Philanthropic Giver', 'Job Title', 'Windfall Company', 'LinkedIn', 'Lifetime Giving', 'Donor Level'],
        filter: { rules: [{ columnTitle: 'Net Worth', operator: 'is_not_empty' }, NOT_DNS] },
        sort: [{ columnTitle: 'Net Worth', direction: 'desc' }] },
      { name: 'By campaign', tag: 'Reference', columns: ['Campaign', 'Personal Email', 'City'],
        filter: { rules: [{ columnTitle: 'Campaign', operator: 'is_not_empty' }] }, sort: [{ columnTitle: 'Campaign' }] },
      ...DNS_VIEWS,
    ],
    deleteStrayViews: ['Build Vibe view'],
  },

  'people-historical': {
    description: 'Everyone from Salesforce with no activity since about 2019: no gift, ' +
      "membership, event registration, or volunteer shift. Same columns as People. Nothing is " +
      "lost — search here when someone 'used to give' and isn't on People. Don't move items by " +
      `hand; a periodic pass will move people between the two boards. Process overview & how-to: ${DOC('46299435')}`,
    groupTitle: 'People',
    columns: [DNS_COLUMN],
    columnDescriptions: {
      ...SHARED_DESCRIPTIONS, ...POSTAL_DESCRIPTIONS, ...WINDFALL_DESCRIPTIONS,
      'Personal Email': "The person's own address. Email consent for this address is in Personal Email Consent.",
      'Household Email': 'A shared household address, possibly used by more than one person. Its ' +
        'consent is tracked separately in Household Email Consent.',
      'DNS Reason Status': DNS_REASON_STATUS_DESC,
    },
    views: [
      { name: 'Find a person', tag: 'Reference', columns: ['Personal Email', 'Phone', 'City', 'Lifetime Giving', 'Last Gift Date'],
        sort: [{ columnTitle: 'Name' }] },
      { name: 'Active again', tag: 'Worklist', columns: ['Personal Email', 'Last Gift Date', 'Membership Status', 'Lifetime Giving'],
        filter: { operator: 'or', rules: [
          { columnTitle: 'Last Gift Date', operator: 'greater_than', compareValue: ['EXACT', '2019-01-01'] },
          { columnTitle: 'Membership Status', operator: 'any_of', labelValues: ['Active'] }] } },
      ...DNS_VIEWS,
    ],
    deleteStrayViews: ['Build Vibe view'],
  },

  'organizations': {
    description: 'True organizations — bike shops, corporate partners, funders, cities and ' +
      'agencies. Kept separate from People; a person and the organization they represent are ' +
      `linked (Organization on People, tenure on Affiliations), never combined. Process overview & how-to: ${DOC('46299435')}`,
    groupTitle: 'Organizations',
    columns: [DNS_COLUMN],
    columnDescriptions: {
      ...SHARED_DESCRIPTIONS,
      'Donor Level': DONOR_LEVEL_DESCRIPTION,
      'Partner Type': "Free text today, straight from Salesforce. Use an existing value for " +
        "consistency. Cities, counties, and public agencies must be 'Municipal' — that's what " +
        'Stakeholder Type on People links against.',
      'Website': 'From Salesforce, or from Google Places where Salesforce had none (exact-name ' +
        'matches only; near-matches await human review).',
    },
    views: [
      { name: 'Find an organization', tag: 'Reference', columns: ['Partner Type', 'City', 'Website', 'Phone', 'Donor Level'],
        sort: [{ columnTitle: 'Name' }] },
      { name: 'Organizations', tag: 'Report', columns: ['Partner Type', 'City', 'Website', 'Lifetime Giving', 'Last Gift Date'],
        groupBy: { columnTitle: 'Donor Level' }, sort: [{ columnTitle: 'Name' }] },
      { name: 'Untyped', tag: 'Worklist', columns: ['Website', 'City', 'Lifetime Giving'],
        filter: { rules: [{ columnTitle: 'Partner Type', operator: 'is_empty' }] }, sort: [{ columnTitle: 'Name' }] },
      { name: 'Municipal', tag: 'Reference', columns: ['Partner Type', 'City', 'Website', 'Phone'],
        filter: { rules: [{ columnTitle: 'Partner Type', operator: 'contains_text', compareValue: 'Municipal' }] } },
      { name: 'Funders and matching companies', tag: 'Report', columns: ['Partner Type', 'Lifetime Giving', 'Last Gift Date', 'This Year Amount'],
        filter: { rules: [{ columnTitle: 'Lifetime Giving', operator: 'greater_than', compareValue: 0 }] }, sort: [{ columnTitle: 'Lifetime Giving', direction: 'desc' }] },
      ...ORG_DNS_VIEWS,
    ],
    deleteStrayViews: ['Build Vibe view'],
  },

  'donations': {
    description: 'Every gift, one item each: Funraise, hand-entered, Click & Pledge history, ' +
      'membership payments, matching gifts. Current and previous fiscal year are active; older ' +
      'gifts are archived on this same board with their amounts and donor links intact ' +
      '(dashboards and search don’t see them — use Annual Giving Summary for closed years). ' +
      `Process overview & how-to: ${DOC('46299439')}`,
    groupTitle: 'Gifts',
    columns: [
      { title: 'Thank You Sent', type: 'checkbox' },
      { title: 'Acknowledgment Tier', type: 'status', labels: ['Standard', 'Major'] },
    ],
    columnDescriptions: {
      'Amount': 'Gift amount in dollars. Drives Acknowledgment Tier and every donor rollup.',
      'Fiscal Year Ending': "SVBC's July–June fiscal year, named by the calendar year it ends " +
        "in (a gift on 2025-08-01 is FY2026). Text on purpose, so it never renders as '2,025'.",
      'Status': 'Received, or Received (Historical) for gifts staff filed under Salesforce’s ' +
        'legacy Closed Won stage (Eventbrite ticket orders also arrive as Closed Won, but those ' +
        'are Received with Gift Type Event Ticket). Failed and Pending are real outcomes, not ' +
        'stages to work.',
      'Gift Type': 'Salesforce record type: Donation, Membership, Matching Donation, Click & ' +
        'Pledge (historical), Sponsorship, Grant, Contract…',
      'Donor': 'Who gave: a People, People (Historical), or Organizations item. Blank only when ' +
        'Anonymous Donor is checked. For a gift an organization made through an affiliated ' +
        'person, the organization is the Donor and the person is in Acting for.',
      'Anonymous Donor': "Checked, with no Donor link, for gifts Salesforce filed under its " +
        "placeholder 'Anonymous Person' contact.",
      'Matched By': 'The company that paid an employer matching gift (Gift Type = Matching ' +
        'Donation). The employee stays in Donor.',
      'Soft Credit': 'Other people Salesforce credited on this gift — a fundraiser, team captain, ' +
        'recruiter or influencer. Reference only: soft credits count toward nobody’s Lifetime Giving.',
      'Benevity Transaction ID': 'Set by the benevity-import integration so a Benevity report ' +
        'row is never entered twice. Blank on migrated history.',
      'Eventbrite Order ID': 'The Eventbrite order behind an Event Ticket gift, set by the eventbrite-sync ' +
        'integration (and carried over from Salesforce on migrated tickets) so an order is never entered twice.',
      'Fee Covered': 'The part of Amount the donor added to cover Funraise’s processing fee. Salesforce kept it ' +
        'as a separate gift; the migration folded it back in. Blank on gifts with no fee covered.',
      'Finance Class': 'The accounting class staff coded in Salesforce (e.g. 4400 Programs:4420 BTWD). ' +
        'Migrated history; coded on gifts from 2020 on.',
      'Revenue Code': 'The revenue account staff coded in Salesforce (e.g. 45100 Special Event Sponsorships). ' +
        'Migrated history; coded on gifts from 2020 on.',
      'Payment Method': 'Credit Card, Cash/Check or Stock, as recorded in Salesforce.',
      'Check/Reference Number': 'Check number or payment reference, for matching a gift to a deposit.',
      'In-Kind Value': 'Retail value of donated goods or services. Amount can be blank or lower on in-kind gifts; ' +
        'this is the value Salesforce recorded.',
      'In-Kind Category': 'What kind of goods or services an in-kind gift was (Bicycle, Travel, Wine…).',
      'Campaign': 'The Salesforce campaign the gift came in under, where known. Reference only.',
      'Recurring Gift': 'Set when this gift is one installment of a recurring pledge.',
      'Thank You Sent': 'Checked automatically for Funraise gifts (Funraise sends the receipt). ' +
        "For hand-entered gifts, check it yourself once you've acknowledged the donor.",
      'Acknowledgment Tier': 'Major at $200 and up, set automatically. Major gifts need a ' +
        "personal acknowledgment — work the 'Major gifts to thank' view.",
      'Funraise ID': 'The transaction in Funraise. Blank for non-Funraise gifts.',
      'Funding Stream': 'Which line of revenue the gift belongs to (individual giving, membership, sponsorship, grant…). ' + NIGHTLY_CLASSIFY,
      'Gift Size': 'The size band of the gift amount, for reporting. ' + NIGHTLY_CLASSIFY,
      'Fiscal Quarter': 'The July–June fiscal quarter the gift date falls in, e.g. FY26 Q2. ' + NIGHTLY_CLASSIFY,
      'Gift Fiscal Year': 'The fiscal year the gift date falls in, e.g. FY2026. ' + NIGHTLY_CLASSIFY,
    },
    views: [
      { name: 'Recent gifts', tag: 'Report',
        columns: ['Donor', 'Amount', 'Date', 'Funding Stream', 'Gift Type', 'Thank You Sent', 'Acknowledgment Tier'],
        groupBy: { columnTitle: 'Gift Fiscal Year', direction: 'desc' }, sort: [{ columnTitle: 'Date', direction: 'desc' }] },
      { name: 'Revenue by funding stream', tag: 'Report', columns: ['Donor', 'Amount', 'Date', 'Gift Fiscal Year', 'Gift Type'],
        groupBy: { columnTitle: 'Funding Stream' }, sort: [{ columnTitle: 'Date', direction: 'desc' }] },
      { name: 'By gift size', tag: 'Report', columns: ['Donor', 'Amount', 'Date', 'Funding Stream'],
        groupBy: { columnTitle: 'Gift Size' }, sort: [{ columnTitle: 'Amount', direction: 'desc' }] },
      { name: 'By fiscal quarter', tag: 'Report', columns: ['Donor', 'Amount', 'Date', 'Funding Stream'],
        groupBy: { columnTitle: 'Fiscal Quarter', direction: 'desc' } },
      { name: 'Major gifts to thank', tag: 'Worklist', columns: ['Donor', 'Amount', 'Date', 'Gift Type', 'Thank You Sent'],
        filter: { rules: [{ columnTitle: 'Acknowledgment Tier', operator: 'any_of', labelValues: ['Major'] }, { columnTitle: 'Thank You Sent', operator: 'is_empty' }] },
        sort: [{ columnTitle: 'Date', direction: 'desc' }] },
      { name: 'Unacknowledged', tag: 'Worklist', columns: ['Donor', 'Amount', 'Date', 'Gift Type'],
        filter: { rules: [{ columnTitle: 'Thank You Sent', operator: 'is_empty' }, { columnTitle: 'Status', operator: 'any_of', labelValues: ['Received'] }] },
        sort: [{ columnTitle: 'Date', direction: 'desc' }] },
      { name: 'Membership payments', tag: 'Reference', columns: ['Donor', 'Amount', 'Term Start', 'Term End', 'Membership Type'],
        filter: { rules: [{ columnTitle: 'Term Start', operator: 'is_not_empty' }] }, sort: [{ columnTitle: 'Term End', direction: 'desc' }] },
      { name: 'Matching gifts', tag: 'Reference', columns: ['Donor', 'Amount', 'Date', 'Matched By'],
        filter: { rules: [{ columnTitle: 'Gift Type', operator: 'contains_text', compareValue: 'Matching Donation' }] }, sort: [{ columnTitle: 'Date', direction: 'desc' }] },
      { name: 'Needs a donor', tag: 'Worklist', columns: ['Amount', 'Date', 'Gift Type', 'Anonymous Donor'],
        filter: { rules: [{ columnTitle: 'Donor', operator: 'is_empty' }, { columnTitle: 'Anonymous Donor', operator: 'is_empty' }] } },
      { name: 'Failed and pending', tag: 'Worklist', columns: ['Donor', 'Amount', 'Date', 'Status'],
        filter: { rules: [{ columnTitle: 'Status', operator: 'any_of', labelValues: ['Failed', 'Pending'] }] },
        coloring: [{ columnTitle: 'Status', labelValues: ['Failed'], color: 'red' }] },
    ],
    deleteStrayViews: ['Major gifts to acknowledge'],
  },

  'recurring-gifts': {
    description: 'One item per recurring pledge or subscription (Funraise subscriptions and ' +
      'the older multi-year pledges). Each installment that lands is its own gift on Donations, ' +
      `linked back here via Recurring Gift. Process overview & how-to: ${DOC('46299439')}`,
    groupTitle: 'Recurring gifts',
    columnDescriptions: {
      'Installment Amount': 'What hits the card each cycle.',
      'Annualized Value': 'Installment × frequency. Use this for stewardship-tier reporting, not Installment Amount.',
      'Status': 'Redacted means payment details were removed under data-retention rules — not a failure.',
      'Pledge Amount': 'Only for the older multi-year pledges; blank for ordinary recurring gifts.',
      'Received Amount': 'Only for the older multi-year pledges; blank for ordinary recurring gifts.',
      'Company Match': 'The donor said an employer match applies; the match itself arrives via Benevity as a separate gift.',
      'Match Employer': 'The donor said an employer match applies; the match itself arrives via Benevity as a separate gift.',
    },
    views: [
      { name: 'Active', tag: 'Report', columns: ['Donor', 'Installment Amount', 'Frequency', 'Annualized Value', 'Next Payment', 'Designation'],
        filter: { rules: [{ columnTitle: 'Status', operator: 'any_of', labelValues: ['Active'] }] }, sort: [{ columnTitle: 'Next Payment' }] },
      { name: 'Failed', tag: 'Worklist', columns: ['Donor', 'Installment Amount', 'Frequency', 'Next Payment', 'Status'],
        filter: { rules: [{ columnTitle: 'Status', operator: 'any_of', labelValues: ['Failed'] }] },
        coloring: [{ columnTitle: 'Status', labelValues: ['Failed'], color: 'red' }] },
      { name: 'Pledges', tag: 'Reference', columns: ['Donor', 'Pledge Amount', 'Received Amount', 'Status'],
        filter: { rules: [{ columnTitle: 'Pledge Amount', operator: 'is_not_empty' }] } },
    ],
    deleteStrayViews: ['Build Vibe view'],
  },

  'campaigns': {
    description: "Salesforce campaigns, kept so each migrated gift's Campaign link still " +
      'resolves. Reference data — not where new outreach is tagged. Tag people for a new push ' +
      'with the Campaign tags column on People instead.',
    groupTitle: 'Campaigns',
    columnDescriptions: {
      'Type': 'Salesforce campaign record type.',
      'Active': "Salesforce's IsActive flag at migration.",
    },
    views: [
      { name: 'All Campaigns', tag: 'Reference', columns: ['Type', 'Start', 'End', 'Active'], sort: [{ columnTitle: 'End', direction: 'desc' }] },
      { name: 'Active', tag: 'Reference', columns: ['Type', 'Start', 'End'], filter: { rules: [{ columnTitle: 'Active', operator: 'is_not_empty' }] } },
    ],
    deleteStrayViews: ['Build Vibe view'],
  },

  'events': {
    description: 'Every event from both platforms — Funraise fundraisers and Eventbrite events ' +
      '(public, volunteering, bike parking, group rides, private). One item per event; who came ' +
      `is on Event Registrations. Process overview & how-to: ${DOC('46299447')}`,
    groupTitle: 'Events',
    columnDescriptions: {
      'Source': 'Which platform the event ran on. Eventbrite events keep their Eventbrite ID / ' +
        'URL; Funraise events keep Funraise Event ID.',
      'Program': 'From which Eventbrite organizer account ran the event (volunteering, bike ' +
        'parking, group rides, private) — Public for the main account, Fundraiser for Funraise events.',
      'Event Status': 'Upcoming, Completed, Canceled, or Draft (an unpublished Eventbrite event somebody registered for).',
      'Tickets Sold': "Eventbrite's count at migration; not maintained until the Eventbrite integration runs.",
    },
    views: [
      { name: 'Upcoming', tag: 'Report', columns: ['Date', 'Program', 'Venue', 'City', 'Tickets Sold', 'Eventbrite URL'],
        filter: { rules: [{ columnTitle: 'Event Status', operator: 'any_of', labelValues: ['Upcoming'] }] }, sort: [{ columnTitle: 'Date' }] },
      { name: 'All events', tag: 'Reference', columns: ['Date', 'Program', 'Event Status', 'Source', 'City'],
        groupBy: { columnTitle: 'Event Status' }, sort: [{ columnTitle: 'Date', direction: 'desc' }],
        coloring: [{ columnTitle: 'Event Status', labelValues: ['Completed', 'Canceled'], color: 'grey' }] },
    ],
    deleteStrayViews: ['Build Vibe view'],
  },

  'event-registrations': {
    description: 'One item per registration or ticket: who (Attendee, when they’re a known ' +
      'person), which Event, whether they attended, and for paid Funraise tickets the matching ' +
      "gift (Payment). Eventbrite registrants who never checked in have no Attendee link — they " +
      `aren't People. Process overview & how-to: ${DOC('46299447')}`,
    groupTitle: 'Registrations',
    columnDescriptions: {
      'Attendee': "The registrant's People item, when they're a known person. Blank for " +
        'Eventbrite registrants who never became contacts; Attendee Name / Email keep what the platform had.',
      'Attendance': 'Registered, Attended, Canceled. No Show is never set by the import — staff ' +
        'set it after an event that took check-in.',
      'Role': 'Volunteer when the event ran on the volunteering organizer account, else Participant.',
      'Payment': 'The Donation item for a paid Funraise ticket.',
      'Deductible Amount': "Funraise's tax-deductible portion of the ticket price.",
    },
    views: [
      { name: 'By event', tag: 'Report', columns: ['Attendee', 'Attendee Name', 'Role', 'Attendance', 'Ticket Amount'],
        groupBy: { columnTitle: 'Event' } },
      { name: 'Volunteers', tag: 'Report', columns: ['Event', 'Attendee', 'Attendee Name', 'Attendance'],
        filter: { rules: [{ columnTitle: 'Role', operator: 'any_of', labelValues: ['Volunteer'] }] } },
      { name: 'Attended', tag: 'Reference', columns: ['Event', 'Attendee', 'Attendee Name', 'Role'],
        filter: { rules: [{ columnTitle: 'Attendance', operator: 'any_of', labelValues: ['Attended'] }] } },
      { name: 'Unlinked attendees', tag: 'Worklist', columns: ['Attendee Name', 'Attendee Email', 'Event'],
        filter: { rules: [{ columnTitle: 'Attendee', operator: 'is_empty' }, { columnTitle: 'Source', operator: 'any_of', labelValues: ['Eventbrite'] }] } },
      { name: 'Needs review', tag: 'Worklist', columns: ['Attendee', 'Event', 'Attribution'],
        filter: { rules: [{ columnTitle: 'Attribution', operator: 'any_of', labelValues: ['Needs review'] }] } },
    ],
  },

  'volunteers': {
    description: "2014–2020 volunteer shifts and hours from Salesforce's old volunteer package. " +
      "Record-keeping only — look here for someone's past hours; new shifts go on Event " +
      'Registrations (Role = Volunteer), and general volunteer interest on the SVBC workspace’s ' +
      `Volunteer registration management board. Process overview & how-to: ${DOC('46299447')}`,
    groupTitle: 'Shifts',
    columnDescriptions: {
      'Historical': 'Always checked on this board: migrated history, not a live roster.',
      'Job': 'The volunteer job title from the Salesforce Volunteers package.',
    },
    views: [
      { name: 'Completed hours', tag: 'Reference', columns: ['Volunteer', 'Job', 'Hours', 'Date'],
        filter: { rules: [{ columnTitle: 'Status', operator: 'any_of', labelValues: ['Completed'] }] }, sort: [{ columnTitle: 'Date', direction: 'desc' }] },
    ],
  },

  'activities': {
    description: 'The communications log: calls, meetings, and significant emails with donors ' +
      'and contacts, plus the migrated Salesforce tasks. Log meaningful touches here; routine ' +
      `email stays in email. Process overview & how-to: ${DOC('46299444')}`,
    groupTitle: 'Activities',
    columns: [
      { title: 'Topic', type: 'tags' },
      { title: 'Assigned To', type: 'people' },
    ],
    columnDescriptions: {
      'Owner': "The Salesforce owner's name, migrated text. For new activities use Assigned To.",
      'Activity Type': 'Task is the migrated Salesforce type; use Call, Meeting, Email, Call ' +
        'summary, or Form request for new entries.',
      'Topic': 'Free tags for what the conversation was about — which ask, which campaign.',
    },
    views: [
      { name: 'My activities', tag: 'Worklist', columns: ['Person', 'Activity Type', 'Date', 'Status', 'Topic'],
        filter: { rules: [{ columnTitle: 'Assigned To', operator: 'any_of', compareValue: ['assigned_to_me'] }] }, sort: [{ columnTitle: 'Date', direction: 'desc' }] },
      { name: 'Recent touches', tag: 'Report', columns: ['Person', 'Date', 'Topic', 'Assigned To', 'Owner'],
        groupBy: { columnTitle: 'Activity Type' }, sort: [{ columnTitle: 'Date', direction: 'desc' }] },
      { name: 'Open', tag: 'Worklist', columns: ['Person', 'Activity Type', 'Date', 'Assigned To', 'Owner'],
        filter: { rules: [{ columnTitle: 'Status', operator: 'not_any_of', labelValues: ['Completed'] }] }, sort: [{ columnTitle: 'Date' }] },
      { name: 'All', tag: 'Reference', columns: ['Person', 'Activity Type', 'Date', 'Status', 'Owner'], sort: [{ columnTitle: 'Date', direction: 'desc' }] },
      { name: 'By person', tag: 'Reference', columns: ['Person', 'Activity Type', 'Date', 'Status'], sort: [{ columnTitle: 'Person' }] },
    ],
  },

  'affiliations': {
    description: 'One item per person-at-organization tenure: role, dates, whether it’s ' +
      'current, and the work email that belongs to it (with its own consent). This is how a ' +
      "person's professional side is represented without a second People item. Draft items were " +
      'proposed by the impact-attribution integration and need staff confirmation.',
    groupTitle: 'Affiliations',
    views: [
      { name: 'Drafts to confirm', tag: 'Worklist', columns: ['Person', 'Organization', 'Affiliation Role', 'Start', 'Work Email'],
        filter: { rules: [{ columnTitle: 'Status', operator: 'any_of', labelValues: ['Draft'] }] } },
      { name: 'Current', tag: 'Reference', columns: ['Person', 'Organization', 'Affiliation Role', 'Start', 'Work Email', 'Primary'],
        filter: { rules: [{ columnTitle: 'Status', operator: 'any_of', labelValues: ['Current'] }] } },
      { name: 'By organization', tag: 'Reference', columns: ['Organization', 'Person', 'Affiliation Role', 'Status'],
        groupBy: { columnTitle: 'Organization' } },
    ],
  },
};

const RAW_DASHBOARD_SPECS: DashboardSpec[] = [
  { name: 'Development — weekly pulse', boards: ['donations', 'people-live', 'people-historical', 'organizations'], widgets: [
    { name: 'Raised this FY', kind: 'NUMBER', number: { boards: ['people-live', 'people-historical', 'organizations'], column: 'This Year Amount', counter: 'sum', format: 'currency' } },
    { name: 'Raised last FY', kind: 'NUMBER', number: { boards: ['people-live', 'people-historical', 'organizations'], column: 'Last Year Amount', counter: 'sum', format: 'currency' } },
    { name: 'Gifts this FY', kind: 'NUMBER', number: { boards: ['people-live', 'people-historical', 'organizations'], column: 'This Year Count', counter: 'sum' } },
    { name: 'Revenue by month', kind: 'CHART', chart: { board: 'donations', graphType: 'column', x: 'Date', xGroupBy: 'date', dateGroupBy: 'month', y: 'Amount' } },
    { name: 'Gifts by size', kind: 'CHART', chart: { board: 'donations', graphType: 'column', x: 'Gift Size', xGroupBy: 'color', y: 'count', z: 'Gift Fiscal Year' } },
    { name: 'Revenue by size', kind: 'CHART', chart: { board: 'donations', graphType: 'stacked_column', x: 'Gift Size', xGroupBy: 'color', y: 'Amount', z: 'Gift Fiscal Year' } },
    { name: 'Donors by level', kind: 'CHART', chart: { board: 'people-live', graphType: 'pie', x: 'Donor Level', xGroupBy: 'color', y: 'count' } },
    { name: 'Major gifts not yet thanked', kind: 'NUMBER', number: { boards: ['donations'], column: 'Amount', counter: 'sum', format: 'currency' },
      filter: { board: 'donations', rules: [{ columnTitle: 'Acknowledgment Tier', operator: 'any_of', labelValues: ['Major'] }, { columnTitle: 'Thank You Sent', operator: 'is_empty' }] } },
  ] },
  { name: 'Membership', boards: ['people-live'], widgets: [
    { name: 'Members by status', kind: 'CHART', chart: { board: 'people-live', graphType: 'pie', x: 'Membership Status', xGroupBy: 'color', y: 'count' } },
    { name: 'Memberships ending, by month', kind: 'CHART', chart: { board: 'people-live', graphType: 'column', x: 'Member Until', xGroupBy: 'date', dateGroupBy: 'month', y: 'count' },
      filter: { board: 'people-live', rules: [{ columnTitle: 'Membership Status', operator: 'any_of', labelValues: ['Active'] }] } },
    { name: 'Members by tier', kind: 'CHART', chart: { board: 'people-live', graphType: 'pie', x: 'Membership Tier', xGroupBy: 'color', y: 'count' } },
  ] },
  { name: 'Board Report — quarterly', boards: ['donations', 'people-live', 'people-historical', 'organizations', 'annual-giving-summary'], widgets: [
    { name: 'Raised this FY', kind: 'NUMBER', number: { boards: ['people-live', 'people-historical', 'organizations'], column: 'This Year Amount', counter: 'sum', format: 'currency' } },
    { name: 'Raised last FY', kind: 'NUMBER', number: { boards: ['people-live', 'people-historical', 'organizations'], column: 'Last Year Amount', counter: 'sum', format: 'currency' } },
    { name: 'Revenue by funding stream, this FY vs last', kind: 'CHART', chart: { board: 'donations', graphType: 'stacked_column', x: 'Funding Stream', xGroupBy: 'color', y: 'Amount', z: 'Gift Fiscal Year' } },
    { name: 'Revenue by fiscal quarter and stream', kind: 'CHART', chart: { board: 'donations', graphType: 'stacked_column', x: 'Fiscal Quarter', xGroupBy: 'color', y: 'Amount', z: 'Funding Stream' } },
    { name: 'Total received by fiscal year', kind: 'CHART', chart: { board: 'annual-giving-summary', graphType: 'column', x: 'name', xGroupBy: 'name', y: 'Total Received' } },
  ] },
];

// Every widget that sums or counts Donations counts Received only — matching computeRollup and
// docs/05's audited revenue definition (Received (Historical) is the user-keyed Closed Won
// residue and is deliberately excluded; Eventbrite's Closed Won ticket orders map to Received
// and so count — transform/donations.ts). AND-ed with any filter the widget already has.
const RECEIVED_RULE: FilterRule = { columnTitle: 'Status', operator: 'any_of', labelValues: ['Received'] };

// ANDs the Received rule onto every NUMBER, CHART and LISTVIEW widget on Donations, except one that
// sets `allStatuses` because it deliberately spans every Status (a Pending or no-donor tile).
export function withReceivedRule(widgets: WidgetSpec[]): WidgetSpec[] {
  return widgets.map((w) => {
    const onDonations = w.chart?.board === 'donations' || w.number?.boards.includes('donations') || w.list?.board === 'donations';
    if (!onDonations || w.allStatuses) return w;
    return { ...w, filter: { board: 'donations', rules: [...(w.filter?.rules ?? []), RECEIVED_RULE] } };
  });
}

export const DASHBOARD_SPECS: DashboardSpec[] = RAW_DASHBOARD_SPECS.map((d) => ({ ...d, widgets: withReceivedRule(d.widgets) }));
