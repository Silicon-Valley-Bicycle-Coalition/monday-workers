import type { OverviewSpec } from './overviews.js';
import type { FilterRule } from './spec.js';
import type { WidgetSpec } from './widgets.js';

// Overview dashboard views (docs/31 in the private planning repo; spec 2026-10-14). Columns are
// referred to by title and resolved to ids at apply time. Each Overview reads only its own board.

// Rollup columns the donation-rollups scripts create (setup-owner-columns.mjs,
// setup-classification-columns.mjs). This repo can't see them statically, so the spec-consistency
// test takes them from here.
export const PROVISIONED_ELSEWHERE: Record<string, string[]> = {
  'people-live': ['Donor Level', 'This Year Count', 'This Year Amount', 'Last Year Amount', 'Last Gift Date', 'Last Gift Amount'],
  organizations: ['Donor Level', 'This Year Count', 'This Year Amount', 'Last Year Amount', 'Last Gift Date'],
};

const is = (columnTitle: string, ...labelValues: string[]): FilterRule => ({ columnTitle, operator: 'any_of', labelValues });
const gt0 = (columnTitle: string): FilterRule => ({ columnTitle, operator: 'greater_than', compareValue: [0] });
const filterOn = (board: string, rules: FilterRule[]) => (rules.length ? { filter: { board, rules } } : {});

const count = (name: string, board: string, rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'NUMBER', number: { boards: [board], count: true }, ...filterOn(board, rules) });
const sum = (name: string, board: string, column: string, rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'NUMBER', number: { boards: [board], column, counter: 'sum', format: 'currency' }, ...filterOn(board, rules) });
const list = (name: string, board: string, columns: string[], rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'LISTVIEW', list: { board, columns }, ...filterOn(board, rules) });
const pie = (name: string, board: string, x: string, rules: FilterRule[] = []): WidgetSpec =>
  ({ name, kind: 'CHART', chart: { board, graphType: 'pie', x, xGroupBy: 'color', y: 'count' }, ...filterOn(board, rules) });

export const OVERVIEW_SPECS: Record<string, OverviewSpec> = {
  'people-live': { widgets: [
    count('Active members', 'people-live', [is('Membership Status', 'Active')]),
    count('Memberships ending in 60 days', 'people-live',
      [is('Membership Status', 'Active'), { columnTitle: 'Member Until', operator: 'within_the_next', compareValue: ['DAYS', 60] }]),
    count('Donors this FY', 'people-live', [gt0('This Year Count')]),
    sum('Raised this FY', 'people-live', 'This Year Amount'),
    pie('Donors by level', 'people-live', 'Donor Level'),
    pie('Members by status', 'people-live', 'Membership Status'),
    list('Find a person', 'people-live', ['Personal Email', 'Phone', 'City', 'Organization', 'Membership Status', 'Donor Level']),
    list('Leadership and major donors', 'people-live',
      ['Donor Level', 'Lifetime Giving', 'Last Gift Date', 'Last Gift Amount', 'Personal Email', 'Phone'],
      [is('Donor Level', 'Leadership', 'Major')]),
  ] },
  organizations: { widgets: [
    count('Organizations giving this FY', 'organizations', [gt0('This Year Count')]),
    sum('Raised this FY', 'organizations', 'This Year Amount'),
    pie('Organizations by donor level', 'organizations', 'Donor Level'),
    list('Find an organization', 'organizations', ['Partner Type', 'City', 'Website', 'Phone', 'Donor Level']),
    list('Funders and matching companies', 'organizations',
      ['Partner Type', 'Lifetime Giving', 'Last Gift Date', 'This Year Amount', 'Donor Level'], [gt0('Lifetime Giving')]),
  ] },
};
