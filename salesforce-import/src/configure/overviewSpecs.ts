import type { OverviewSpec } from './overviews.js';
import { UPCOMING_EVENT, withReceivedRule, type FilterRule } from './spec.js';
import type { WidgetSpec } from './widgets.js';

// Overview dashboard views (docs/31 in the private planning repo; spec 2026-10-14). Columns are
// referred to by title and resolved to ids at apply time. Each Overview reads only its own board.

// Rollup columns the donation-rollups scripts create (setup-owner-columns.mjs,
// setup-classification-columns.mjs). This repo can't see them statically, so the spec-consistency
// test takes them from here.
export const PROVISIONED_ELSEWHERE: Record<string, string[]> = {
  'people-live': ['Donor Level', 'This Year Count', 'This Year Amount', 'Last Year Amount', 'Last Gift Date', 'Last Gift Amount'],
  organizations: ['Donor Level', 'This Year Count', 'This Year Amount', 'Last Year Amount', 'Last Gift Date'],
  donations: ['Gift Fiscal Year', 'Funding Stream', 'Gift Size'],
  'people-historical': ['This Year Amount'],
  'annual-giving-summary': ['Total Received'],
};

// ---- rule shorthand -------------------------------------------------------------------------
const is = (columnTitle: string, ...labelValues: string[]): FilterRule => ({ columnTitle, operator: 'any_of', labelValues });
const gt0 = (columnTitle: string): FilterRule => ({ columnTitle, operator: 'greater_than', compareValue: [0] });
const empty = (columnTitle: string): FilterRule => ({ columnTitle, operator: 'is_empty' });
const notEmpty = (columnTitle: string): FilterRule => ({ columnTitle, operator: 'is_not_empty' });
const thisFYDates = (columnTitle: string): FilterRule => ({ columnTitle, operator: 'between', compareValue: { fiscalYear: 'current' } });
const within = (columnTitle: string, operator: 'within_the_next' | 'within_the_last', unit: 'DAYS' | 'MONTHS', n: number): FilterRule =>
  ({ columnTitle, operator, compareValue: [unit, n] });
const thisFY = is('Gift Fiscal Year', '@FY');
const lastFY = is('Gift Fiscal Year', '@FY-1');

// The existing worklist views' own filters (spec.ts), so a tile and its tab agree. Exception: on
// Donations the Received rule is added (spec D8), and the worklist tab also shows Pending and Failed gifts.
const NOT_DNS: FilterRule = { columnTitle: 'Do Not Solicit', operator: 'is_empty' };
const LYBUNT: FilterRule[] = [gt0('Last Year Amount'), { columnTitle: 'This Year Count', operator: 'lower_than', compareValue: [1] }, NOT_DNS];
const MAJOR_TO_THANK: FilterRule[] = [is('Acknowledgment Tier', 'Major'), empty('Thank You Sent')];

// ---- widget shorthand -----------------------------------------------------------------------
const filterOn = (board: string, rules: FilterRule[]) => (rules.length ? { filter: { board, rules } } : {});
const count = (name: string, board: string, rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'NUMBER', number: { boards: [board], count: true }, ...filterOn(board, rules) });
const sum = (name: string, board: string, column: string, rules: FilterRule[] = [], format: 'currency' | 'number' = 'currency'): WidgetSpec =>
  ({ name, kind: 'NUMBER', number: { boards: [board], column, counter: 'sum', format }, ...filterOn(board, rules) });
const avg = (name: string, board: string, column: string, rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'NUMBER', number: { boards: [board], column, counter: 'average', format: 'currency' }, ...filterOn(board, rules) });
const list = (name: string, board: string, columns: string[], rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'LISTVIEW', list: { board, columns }, ...filterOn(board, rules) });
const pie = (name: string, board: string, x: string, rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'CHART', chart: { board, graphType: 'pie', x, xGroupBy: 'color', y: 'count' }, ...filterOn(board, rules) });
const donut = (name: string, board: string, x: string, rules: FilterRule[] = [], y: string = 'count'): WidgetSpec =>
  ({ name, kind: 'CHART', chart: { board, graphType: 'donut', x, xGroupBy: 'color', y }, ...filterOn(board, rules) });
const bars = (name: string, board: string, x: string, y: string, rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'CHART', chart: { board, graphType: 'column', x, xGroupBy: 'color', y }, ...filterOn(board, rules) });
const overTime = (name: string, board: string, x: string, y: string, dateGroupBy: 'month' | 'quarter' | 'year',
  rules: FilterRule[] = [], extra: { graphType?: string; z?: string } = {}): WidgetSpec =>
  ({ name, kind: 'CHART', chart: { board, graphType: extra.graphType ?? 'column', x, xGroupBy: 'date', dateGroupBy, y, ...(extra.z ? { z: extra.z } : {}) }, ...filterOn(board, rules) });
const calendar = (name: string, board: string, dateColumn: string, colorBy?: string): WidgetSpec =>
  ({ name, kind: 'CALENDAR', calendar: { board, dateColumn, ...(colorBy ? { colorBy } : {}) } });
const allStatuses = (w: WidgetSpec): WidgetSpec => ({ ...w, allStatuses: true });

const RAW_OVERVIEW_SPECS: Record<string, OverviewSpec> = {
  // docs/31 §4.1 — widgets marked (built) exist on the sandbox Overview since 2026-10-09 (#51).
  'people-live': { widgets: [
    count('Active members', 'people-live', [is('Membership Status', 'Active')]),                                    // built
    count('Memberships ending in 60 days', 'people-live',
      [is('Membership Status', 'Active'), within('Member Until', 'within_the_next', 'DAYS', 60)]),               // built
    count('Donors this FY', 'people-live', [gt0('This Year Count')]),                                              // built
    sum('Raised this FY', 'people-live', 'This Year Amount'),                                                      // built
    count('Gave last year, not this year', 'people-live', LYBUNT),
    sum('Raised last FY', 'people-live', 'Last Year Amount'),
    list('Find a person', 'people-live', ['Personal Email', 'Phone', 'City', 'Organization', 'Membership Status', 'Donor Level']), // built
    list('Leadership and major donors', 'people-live',
      ['Donor Level', 'Lifetime Giving', 'Last Gift Date', 'Last Gift Amount', 'Personal Email', 'Phone'],
      [is('Donor Level', 'Leadership', 'Major')]),                                                                 // built
    list('Gave last year, not this year (list)', 'people-live', ['Last Year Amount', 'Phone', 'Personal Email'], LYBUNT),
    pie('Donors by level', 'people-live', 'Donor Level'),                                                          // built
    pie('Members by status', 'people-live', 'Membership Status'),                                                  // built
    overTime('New donors by month', 'people-live', 'First Gift', 'count', 'month', [within('First Gift', 'within_the_last', 'MONTHS', 24)]),
    overTime('Renewals due by year', 'people-live', 'Member Until', 'count', 'year', [is('Membership Status', 'Active')]),
  ] },

  // docs/31 §4.2
  organizations: { widgets: [
    count('Organizations giving this FY', 'organizations', [gt0('This Year Count')]),                              // built
    sum('Raised this FY', 'organizations', 'This Year Amount'),                                                    // built
    sum('Raised last FY', 'organizations', 'Last Year Amount'),
    count('Untyped', 'organizations', [empty('Partner Type')]),
    count('DNS reason missing', 'organizations', [is('DNS Reason Status', 'Missing')]),
    list('Find an organization', 'organizations', ['Partner Type', 'City', 'Website', 'Phone', 'Donor Level']),    // built
    list('Funders and matching companies', 'organizations',
      ['Partner Type', 'Lifetime Giving', 'Last Gift Date', 'This Year Amount', 'Donor Level'], [gt0('Lifetime Giving')]), // built
    pie('Organizations by donor level', 'organizations', 'Donor Level'),                                           // built
    bars('Raised this FY by donor level', 'organizations', 'Donor Level', 'This Year Amount'),
  ] },

  // docs/31 §4.3 — Received is added to all but the two allStatuses tiles (withReceivedRule below).
  donations: { widgets: [
    sum('Received this FY', 'donations', 'Amount', [thisFY]),
    count('Gifts this FY', 'donations', [thisFY]),
    avg('Average gift this FY', 'donations', 'Amount', [thisFY]),
    sum('Received last FY', 'donations', 'Amount', [lastFY]),
    count('Major gifts to thank', 'donations', MAJOR_TO_THANK),
    sum('Major gifts to thank, $', 'donations', 'Amount', MAJOR_TO_THANK),
    allStatuses(sum('Pending', 'donations', 'Amount', [is('Status', 'Pending')])),
    allStatuses(count('Needs a donor', 'donations', [empty('Donor'), empty('Anonymous Donor')])),
    list('Major gifts to thank (list)', 'donations', ['Donor', 'Amount', 'Date'], MAJOR_TO_THANK),
    overTime('Revenue by month', 'donations', 'Date', 'Amount', 'month', [], { graphType: 'stacked_column', z: 'Gift Fiscal Year' }),
    donut('Revenue by Funding Stream', 'donations', 'Funding Stream', [thisFY], 'Amount'),
    donut('Gifts by Gift Size', 'donations', 'Gift Size', [thisFY]),
  ] },

  // docs/31 §4.4
  'recurring-gifts': { widgets: [
    count('Active pledges', 'recurring-gifts', [is('Status', 'Active')]),
    sum('Annualized value', 'recurring-gifts', 'Annualized Value', [is('Status', 'Active')]),
    sum('Received to date', 'recurring-gifts', 'Received Amount'),
    sum('Expected next 30 days', 'recurring-gifts', 'Installment Amount', [is('Status', 'Active'), within('Next Payment', 'within_the_next', 'DAYS', 30)]),
    count('Failed', 'recurring-gifts', [is('Status', 'Failed')]),
    list('Failed pledges', 'recurring-gifts', ['Donor', 'Installment Amount', 'Next Payment'], [is('Status', 'Failed')]),
    donut('Active pledges by Frequency', 'recurring-gifts', 'Frequency', [is('Status', 'Active')]),
    overTime('Next installment by month', 'recurring-gifts', 'Next Payment', 'Installment Amount', 'month', [is('Status', 'Active')]),
    donut('Pledges by Status', 'recurring-gifts', 'Status'),
  ] },

  // docs/31 §4.5
  events: { widgets: [
    count('Events', 'events'),
    count('Upcoming', 'events', UPCOMING_EVENT),
    sum('Tickets sold', 'events', 'Tickets Sold', [], 'number'),
    count('Drafts', 'events', [is('Event Status', 'Draft')]),
    // coloured by board (verified); colorBy 'Program' is unverified, see docs/31 §9
    calendar('Calendar', 'events', 'Date'),
    donut('Events by Program', 'events', 'Program'),
    overTime('Events by year', 'events', 'Date', 'count', 'year'),
    bars('Tickets sold by Program', 'events', 'Program', 'Tickets Sold'),
  ] },

  // docs/31 §5 — health strips. Filters are the existing worklist views' own (spec.ts).
  'people-historical': { widgets: [
    count('People', 'people-historical'),
    sum('Lifetime giving', 'people-historical', 'Lifetime Giving'),
    count('Members ever', 'people-historical', [notEmpty('Membership Status')]),
    count('Gave this year', 'people-historical', [gt0('This Year Amount')]),       // should be 0: a donor here belongs on People
  ] },
  affiliations: { widgets: [
    count('Affiliations', 'affiliations'),
    count('Current', 'affiliations', [is('Status', 'Current')]),
    count('Drafts to confirm', 'affiliations', [is('Status', 'Draft')]),
    sum('Attributed giving', 'affiliations', 'Attributed Giving'),
  ] },
  campaigns: { widgets: [
    count('Campaigns', 'campaigns'),
    count('Active', 'campaigns', [notEmpty('Active')]),
    count('Ended this FY', 'campaigns', [thisFYDates('End')]),
  ] },
  'annual-giving-summary': { widgets: [
    count('Fiscal years', 'annual-giving-summary'),
    sum('Total received, all years', 'annual-giving-summary', 'Total Received'),
    sum('Gifts, all years', 'annual-giving-summary', 'Gift Count', [], 'number'),
    { name: 'Total received by fiscal year', kind: 'CHART',
      chart: { board: 'annual-giving-summary', graphType: 'column', x: 'name', xGroupBy: 'name', y: 'Total Received' } },
  ] },
  'event-registrations': { widgets: [
    count('Registrations', 'event-registrations'),
    count('Attended', 'event-registrations', [is('Attendance', 'Attended')]),
    sum('Volunteer hours', 'event-registrations', 'Hours', [], 'number'),
    count('Unlinked attendees', 'event-registrations', [empty('Attendee'), is('Source', 'Eventbrite', 'Funraise')]),
  ] },
  volunteers: { widgets: [
    count('Shifts', 'volunteers'),
    sum('Hours', 'volunteers', 'Hours', [], 'number'),
    sum('Hours this FY', 'volunteers', 'Hours', [thisFYDates('Date')], 'number'),
    count('Unlinked', 'volunteers', [empty('Volunteer')]),
  ] },
  activities: { widgets: [
    count('Activities', 'activities'),
    count('Open', 'activities', [{ columnTitle: 'Status', operator: 'not_any_of', labelValues: ['Completed'] }]),
    count('Last 30 days', 'activities', [within('Date', 'within_the_last', 'DAYS', 30)]),
    count('Unlinked', 'activities', [empty('Person')]),
    donut('Activities by Activity Type', 'activities', 'Activity Type'),
  ] },
};

export const OVERVIEW_SPECS: Record<string, OverviewSpec> = Object.fromEntries(
  Object.entries(RAW_OVERVIEW_SPECS).map(([key, s]) => [key, { widgets: withReceivedRule(s.widgets) }]));
