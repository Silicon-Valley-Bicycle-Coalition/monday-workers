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
  operator: string; // any_of | not_any_of | is_empty | is_not_empty | contains_text | greater_than | ...
  labelValues?: string[]; // resolved to label ids at apply time (status/dropdown columns)
  compareValue?: unknown; // literal compare value for non-label columns; default [] when omitted
}

export interface ViewSpec {
  name: string;
  filter?: { operator?: 'and' | 'or'; rules: FilterRule[] };
  sort?: { columnTitle: string; direction?: 'asc' | 'desc' }[];
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
const ROLLUP_DESCRIPTION = 'Computed automatically from Donations by the donation-rollups integration. Edits are overwritten.';
const DNS_REASON_STATUS_DESC = "Missing means Do Not Solicit is checked with no reason recorded. " +
  "Maintained by automation; review the 'DNS reason missing' view.";

const DNS_COLUMN: ColumnSpec = { title: 'DNS Reason Status', type: 'status', labels: ['OK', 'Missing'] };

const DNS_VIEWS: ViewSpec[] = [
  { name: 'Do Not Solicit', filter: { rules: [{ columnTitle: 'Do Not Solicit', operator: 'is_not_empty' }] } },
  { name: 'DNS reason missing', filter: { rules: [{ columnTitle: 'DNS Reason Status', operator: 'any_of', labelValues: ['Missing'] }] } },
];

export const BOARD_SPECS: Record<string, BoardSpec> = {
  'people-live': {
    description: 'Individual donors, members, and other real-relationship contacts with activity ' +
      'since about 2019. A person is always a separate item from any organization they’re ' +
      `linked to (see Organizations and Affiliations). Process overview & how-to: ${DOC('46299435')}`,
    groupTitle: 'People',
    columns: [
      { title: 'Stakeholder Type', type: 'status', labels: ['Individual Donor', 'City or Agency Staff', 'Elected Official', 'Partner Org Contact'] },
      { title: 'Campaign', type: 'tags' },
      DNS_COLUMN,
    ],
    columnDescriptions: {
      ...SHARED_DESCRIPTIONS,
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
    },
    views: [
      { name: 'Active members', filter: { rules: [{ columnTitle: 'Membership Status', operator: 'any_of', labelValues: ['Active'] }] }, sort: [{ columnTitle: 'Name' }] },
      { name: 'Stakeholders', filter: { rules: [{ columnTitle: 'Stakeholder Type', operator: 'any_of', labelValues: ['City or Agency Staff', 'Elected Official'] }] } },
      { name: 'By campaign', filter: { rules: [{ columnTitle: 'Campaign', operator: 'is_not_empty' }] }, sort: [{ columnTitle: 'Campaign' }] },
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
      ...SHARED_DESCRIPTIONS,
      'Personal Email': "The person's own address. Email consent for this address is in Personal Email Consent.",
      'Household Email': 'A shared household address, possibly used by more than one person. Its ' +
        'consent is tracked separately in Household Email Consent.',
      'DNS Reason Status': DNS_REASON_STATUS_DESC,
    },
    views: [...DNS_VIEWS],
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
      'Partner Type': "Free text today, straight from Salesforce. Use an existing value for " +
        "consistency. Cities, counties, and public agencies must be 'Municipal' — that's what " +
        'Stakeholder Type on People links against.',
      'Website': 'From Salesforce, or from Google Places where Salesforce had none (exact-name ' +
        'matches only; near-matches await human review).',
    },
    views: [
      { name: 'Untyped', filter: { rules: [{ columnTitle: 'Partner Type', operator: 'is_empty' }] }, sort: [{ columnTitle: 'Name' }] },
      { name: 'Municipal', filter: { rules: [{ columnTitle: 'Partner Type', operator: 'contains_text', compareValue: 'Municipal' }] } },
      { name: 'Funders and matching companies', filter: { rules: [{ columnTitle: 'Lifetime Giving', operator: 'greater_than', compareValue: 0 }] }, sort: [{ columnTitle: 'Lifetime Giving', direction: 'desc' }] },
      ...DNS_VIEWS,
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
      'Status': 'Received, or Received (Historical) for gifts Salesforce still filed under its ' +
        'retired Closed Won stage. Failed and Pending are real outcomes, not stages to work.',
      'Gift Type': 'Salesforce record type: Donation, Membership, Matching Donation, Click & ' +
        'Pledge (historical), Sponsorship, Grant, Contract…',
      'Donor': 'Who gave: a People, People (Historical), or Organizations item. Blank only when ' +
        'Anonymous Donor is checked. For a gift an organization made through an affiliated ' +
        'person, the organization is the Donor and the person is in Acting for.',
      'Anonymous Donor': "Checked, with no Donor link, for gifts Salesforce filed under its " +
        "placeholder 'Anonymous Person' contact.",
      'Matched By': 'The company that paid an employer matching gift (Gift Type = Matching ' +
        'Donation). The employee stays in Donor.',
      'Benevity Transaction ID': 'Set by the benevity-import integration so a Benevity report ' +
        'row is never entered twice. Blank on migrated history.',
      'Campaign': 'The Salesforce campaign the gift came in under, where known. Reference only.',
      'Recurring Gift': 'Set when this gift is one installment of a recurring pledge.',
      'Thank You Sent': 'Checked automatically for Funraise gifts (Funraise sends the receipt). ' +
        "For hand-entered gifts, check it yourself once you've acknowledged the donor.",
      'Acknowledgment Tier': 'Major at $200 and up, set automatically. Major gifts need a ' +
        "personal acknowledgment — work the 'Major gifts to acknowledge' view.",
      'Funraise ID': 'The transaction in Funraise. Blank for non-Funraise gifts.',
    },
    views: [
      { name: 'Major gifts to acknowledge', filter: { rules: [
        { columnTitle: 'Acknowledgment Tier', operator: 'any_of', labelValues: ['Major'] },
        { columnTitle: 'Thank You Sent', operator: 'is_empty' },
      ] }, sort: [{ columnTitle: 'Date', direction: 'desc' }] },
      { name: 'Matching gifts', filter: { rules: [{ columnTitle: 'Gift Type', operator: 'contains_text', compareValue: 'Matching Donation' }] }, sort: [{ columnTitle: 'Date', direction: 'desc' }] },
      { name: 'Needs a donor', filter: { rules: [
        { columnTitle: 'Donor', operator: 'is_empty' },
        { columnTitle: 'Anonymous Donor', operator: 'is_empty' },
      ] } },
      { name: 'Failed and pending', filter: { rules: [{ columnTitle: 'Status', operator: 'any_of', labelValues: ['Failed', 'Pending'] }] } },
    ],
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
      { name: 'Active', filter: { rules: [{ columnTitle: 'Status', operator: 'any_of', labelValues: ['Active'] }] }, sort: [{ columnTitle: 'Next Payment' }] },
      { name: 'Failed', filter: { rules: [{ columnTitle: 'Status', operator: 'any_of', labelValues: ['Failed'] }] } },
      { name: 'Pledges', filter: { rules: [{ columnTitle: 'Pledge Amount', operator: 'is_not_empty' }] } },
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
      { name: 'Active', filter: { rules: [{ columnTitle: 'Active', operator: 'is_not_empty' }] } },
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
      { name: 'Upcoming', filter: { rules: [{ columnTitle: 'Event Status', operator: 'any_of', labelValues: ['Upcoming'] }] }, sort: [{ columnTitle: 'Date' }] },
      { name: 'All events', sort: [{ columnTitle: 'Date', direction: 'desc' }] },
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
      { name: 'Volunteers', filter: { rules: [{ columnTitle: 'Role', operator: 'any_of', labelValues: ['Volunteer'] }] } },
      { name: 'Attended', filter: { rules: [{ columnTitle: 'Attendance', operator: 'any_of', labelValues: ['Attended'] }] } },
      { name: 'Unlinked attendees', filter: { rules: [
        { columnTitle: 'Attendee', operator: 'is_empty' },
        { columnTitle: 'Source', operator: 'any_of', labelValues: ['Eventbrite'] },
      ] } },
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
      { name: 'Completed hours', filter: { rules: [{ columnTitle: 'Status', operator: 'any_of', labelValues: ['Completed'] }] } },
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
      { name: 'All', sort: [{ columnTitle: 'Date', direction: 'desc' }] },
    ],
  },

  'affiliations': {
    description: 'One item per person-at-organization tenure: role, dates, whether it’s ' +
      'current, and the work email that belongs to it (with its own consent). This is how a ' +
      "person's professional side is represented without a second People item. Draft items were " +
      'proposed by the impact-attribution integration and need staff confirmation.',
    groupTitle: 'Affiliations',
    views: [
      { name: 'Current', filter: { rules: [{ columnTitle: 'Status', operator: 'any_of', labelValues: ['Current'] }] } },
      { name: 'Drafts to confirm', filter: { rules: [{ columnTitle: 'Status', operator: 'any_of', labelValues: ['Draft'] }] } },
      { name: 'By organization', sort: [{ columnTitle: 'Organization' }] },
    ],
  },
};
