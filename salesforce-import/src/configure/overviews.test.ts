import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planOverview, decideOverview, configureOverviews, overviewScope, parseRebuild, type OverviewSpec } from './overviews.js';
import type { Columns } from './widgets.js';
import type { DashboardState } from './dashboards.js';
import type { MondayClient } from '../load/monday.js';
import { dataPath, readJson, writeJson } from '../artifacts.js';
import { col } from './testFixtures.js';

const COLS = [
  col('name', 'Name', 'name'),
  col('ms', 'Membership Status', 'status', '{"labels":{"0":"Active","1":"Lapsed"}}'),
  col('tya', 'This Year Amount'),
];
const COLUMNS: Columns = new Map([['people-live', { boardId: 20, columns: COLS }]]);
const SPEC: OverviewSpec = { widgets: [
  { name: 'Active members', kind: 'NUMBER', number: { boards: ['people-live'], count: true },
    filter: { board: 'people-live', rules: [{ columnTitle: 'Membership Status', operator: 'any_of', labelValues: ['Active'] }] } },
  { name: 'Raised this FY', kind: 'NUMBER', number: { boards: ['people-live'], column: 'This Year Amount', counter: 'sum', format: 'currency' } },
  { name: 'Members by status', kind: 'CHART', chart: { board: 'people-live', graphType: 'pie', x: 'Membership Status', xGroupBy: 'color', y: 'count' } },
] };

describe('planOverview', () => {
  it('resolves every widget in spec order, with its filter', () => {
    const plan = planOverview(SPEC, COLUMNS);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.widgets.map((w) => w.name)).toEqual(['Active members', 'Raised this FY', 'Members by status']);
    expect(plan.widgets[0]!.filter).toEqual({ operator: 'and', rules: [{ column_id: 'ms', operator: 'any_of', compare_value: [0] }] });
    expect(plan.widgets[1]!.filter).toBeUndefined();
  });

  it('refuses the whole Overview when one widget cannot resolve (an Overview is created whole or not at all)', () => {
    const cols: Columns = new Map([['people-live', { boardId: 20, columns: COLS.filter((c) => c.title !== 'This Year Amount') }]]);
    const plan = planOverview(SPEC, cols);
    expect(plan).toEqual({ ok: false, errors: ['widget "Raised this FY": board "people-live" has no column "This Year Amount"'] });
  });

  it('refuses an unknown label, naming the widget', () => {
    const spec: OverviewSpec = { widgets: [{ name: 'Gone', kind: 'NUMBER', number: { boards: ['people-live'], count: true },
      filter: { board: 'people-live', rules: [{ columnTitle: 'Membership Status', operator: 'any_of', labelValues: ['Nope'] }] } }] };
    const plan = planOverview(spec, COLUMNS);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.errors[0]).toMatch(/widget "Gone".*unknown label/);
  });

  it('refuses duplicate widget names, which would collide in the state file', () => {
    const plan = planOverview({ widgets: [SPEC.widgets[0]!, SPEC.widgets[0]!] }, COLUMNS);
    expect(plan).toEqual({ ok: false, errors: ['duplicate widget name "Active members"'] });
  });
});

describe('decideOverview', () => {
  const names = ['A', 'B'];
  it('creates when the board has no Overview, even if state remembers one (stale)', () => {
    expect(decideOverview({ specNames: names })).toEqual({ kind: 'create' });
    expect(decideOverview({ entry: { id: 'v1', widgets: {}, complete: true }, specNames: names })).toEqual({ kind: 'create' });
  });
  it('adopts an Overview that state does not know, or knows under a different id', () => {
    expect(decideOverview({ viewId: 'v7', specNames: names })).toEqual({ kind: 'adopt', viewId: 'v7' });
    expect(decideOverview({ entry: { id: 'v1', widgets: {}, complete: true }, viewId: 'v7', specNames: names })).toEqual({ kind: 'adopt', viewId: 'v7' });
  });
  it('leaves an adopted or complete Overview alone', () => {
    expect(decideOverview({ entry: { id: 'v7', widgets: {}, adopted: true }, viewId: 'v7', specNames: names })).toEqual({ kind: 'leave' });
    expect(decideOverview({ entry: { id: 'v7', widgets: { A: 'w1', B: 'w2' }, complete: true }, viewId: 'v7', specNames: names })).toEqual({ kind: 'leave' });
  });
  it('replaces a half-built view that configure itself made', () => {
    expect(decideOverview({ entry: { id: 'v7', widgets: { A: 'w1' } }, viewId: 'v7', specNames: names })).toEqual({ kind: 'replace', viewId: 'v7', why: 'half-built' });
  });
  it('reports, and changes nothing, when a complete Overview is behind the spec', () => {
    const a = decideOverview({ entry: { id: 'v7', widgets: { A: 'w1' }, complete: true }, viewId: 'v7', specNames: names });
    expect(a.kind).toBe('leave');
    expect((a as { note?: string }).note).toMatch(/behind the spec \(missing: B\)/);
  });
});

type Call = { query: string; variables: Record<string, unknown>; opts?: { idempotent?: boolean; apiVersion?: string } };
const BOARD_IDS = { 'people-live': 20 };
const SPECS = { 'people-live': SPEC };
const STATE = () => dataPath('load', 'dashboards.json');
const KEY = 'overview:people-live';

function fake(o: { views?: { id: string; name: string }[]; failOnWidget?: number; columns?: typeof COLS } = {}) {
  const calls: Call[] = [];
  const views = [...(o.views ?? [])];
  let widgets = 0;
  let viewSeq = 100;
  const client = { async gql(query: string, variables: Record<string, unknown> = {}, opts?: Call['opts']) {
    calls.push({ query, variables, opts });
    if (/^\s*query/.test(query)) return { boards: [{ columns: o.columns ?? COLS, views }] };
    if (/create_view/.test(query)) { const id = String(++viewSeq); views.push({ id, name: String(variables['name']) }); return { create_view: { id } }; }
    if (/delete_view/.test(query)) { const i = views.findIndex((v) => v.id === variables['view']); if (i >= 0) views.splice(i, 1); return { delete_view: { id: variables['view'] } }; }
    if (/create_widget/.test(query)) { widgets++; if (widgets === o.failOnWidget) throw new Error('boom'); return { create_widget: { id: `w${widgets}` } }; }
    throw new Error('unexpected ' + query);
  } } as unknown as MondayClient;
  return { client, calls, mutations: () => calls.filter((c) => /^\s*mutation/.test(c.query)) };
}

describe('configureOverviews', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });

  it('creates the view and every widget in order, as non-idempotent writes on API 2026-10, and records state', async () => {
    const f = fake();
    const r = await configureOverviews(f.client, BOARD_IDS, false, SPECS);
    expect(r.ok).toBe(true);
    const m = f.mutations();
    expect(m.map((c) => (/create_view/.test(c.query) ? 'view' : String(c.variables['name'])))).toEqual(['view', 'Active members', 'Raised this FY', 'Members by status']);
    for (const c of m) expect(c.opts).toEqual({ idempotent: false, apiVersion: '2026-10' });
    expect(m[1]!.variables['parent']).toEqual({ kind: 'BOARD_VIEW', id: '101' });
    expect((await readJson<DashboardState>(STATE()))[KEY]).toEqual(
      { id: '101', widgets: { 'Active members': 'w1', 'Raised this FY': 'w2', 'Members by status': 'w3' }, complete: true });
  });

  it('dry-run makes no mutations and writes no state', async () => {
    const f = fake();
    const r = await configureOverviews(f.client, BOARD_IDS, true, SPECS);
    expect(r.summary).toMatch(/would create Overview on people-live \(3 widgets\)/);
    expect(f.mutations()).toEqual([]);
    expect(existsSync(STATE())).toBe(false);
  });

  it('a second run creates nothing', async () => {
    await configureOverviews(fake().client, BOARD_IDS, false, SPECS);
    const again = fake({ views: [{ id: '101', name: 'Overview' }] });
    const r = await configureOverviews(again.client, BOARD_IDS, false, SPECS);
    expect(again.mutations()).toEqual([]);
    expect(r.summary).toBe('overviews up to date');
  });

  it('refuses when a widget cannot resolve: nothing is created, ok is false, the note says why (D1, D9)', async () => {
    const f = fake({ columns: COLS.filter((c) => c.title !== 'This Year Amount') });
    const r = await configureOverviews(f.client, BOARD_IDS, false, SPECS);
    expect(f.mutations()).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.notes.join()).toMatch(/people-live: Overview not created — widget "Raised this FY"/);
  });

  it('a refusal never deletes an existing half-built view', async () => {
    await writeJson(STATE(), { [KEY]: { id: 'v9', widgets: { 'Active members': 'w1' } } });
    const f = fake({ views: [{ id: 'v9', name: 'Overview' }], columns: COLS.filter((c) => c.title !== 'This Year Amount') });
    const r = await configureOverviews(f.client, BOARD_IDS, false, SPECS);
    expect(f.mutations()).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('adopts a hand-built Overview with no create, update or delete call', async () => {
    const f = fake({ views: [{ id: 'v7', name: 'Overview' }] });
    const r = await configureOverviews(f.client, BOARD_IDS, false, SPECS);
    expect(f.mutations()).toEqual([]);
    expect(r.summary).toMatch(/adopted existing Overview on people-live/);
    expect((await readJson<DashboardState>(STATE()))[KEY]).toEqual({ id: 'v7', widgets: {}, adopted: true });
  });

  it('replaces a half-built leftover whole: delete first, then create everything', async () => {
    await writeJson(STATE(), { [KEY]: { id: 'v9', widgets: { 'Active members': 'w1' } } });
    const f = fake({ views: [{ id: 'v9', name: 'Overview' }] });
    await configureOverviews(f.client, BOARD_IDS, false, SPECS);
    const m = f.mutations();
    expect(m.map((c) => (/delete_view/.test(c.query) ? 'delete' : /create_view/.test(c.query) ? 'view' : 'widget'))).toEqual(['delete', 'view', 'widget', 'widget', 'widget']);
    expect(m[0]!.variables).toEqual({ view: 'v9', board: '20' });
    expect((await readJson<DashboardState>(STATE()))[KEY]!.complete).toBe(true);
  });

  it('a run killed mid-way leaves state incomplete, and the next run rebuilds whole (Review Focus 2)', async () => {
    const failing = fake({ failOnWidget: 2 });
    await expect(configureOverviews(failing.client, BOARD_IDS, false, SPECS)).rejects.toThrow('boom');
    expect((await readJson<DashboardState>(STATE()))[KEY]).toEqual({ id: '101', widgets: { 'Active members': 'w1' } });

    const retry = fake({ views: [{ id: '101', name: 'Overview' }] });
    await configureOverviews(retry.client, BOARD_IDS, false, SPECS);
    expect(retry.mutations().map((c) => (/delete_view/.test(c.query) ? 'delete' : /create_view/.test(c.query) ? 'view' : 'widget'))).toEqual(['delete', 'view', 'widget', 'widget', 'widget']);
  });

  it('forgets stale state when the view is gone, and creates fresh without a delete', async () => {
    await writeJson(STATE(), { [KEY]: { id: 'v9', widgets: { 'Active members': 'w1' }, complete: true } });
    const f = fake();
    await configureOverviews(f.client, BOARD_IDS, false, SPECS);
    expect(f.mutations().some((c) => /delete_view/.test(c.query))).toBe(false);
    expect((await readJson<DashboardState>(STATE()))[KEY]!.id).toBe('101');
  });

  it('reports a complete Overview that is behind the spec and changes nothing', async () => {
    await writeJson(STATE(), { [KEY]: { id: 'v9', widgets: { 'Active members': 'w1' }, complete: true } });
    const f = fake({ views: [{ id: 'v9', name: 'Overview' }] });
    const r = await configureOverviews(f.client, BOARD_IDS, false, SPECS);
    expect(f.mutations()).toEqual([]);
    expect(r.notes.join()).toMatch(/people-live: Overview is behind the spec \(missing: Raised this FY, Members by status\)/);
  });

  it('skips a board with no id, with a note', async () => {
    const f = fake();
    const r = await configureOverviews(f.client, {}, false, SPECS);
    expect(f.calls).toEqual([]);
    expect(r.notes.join()).toMatch(/people-live: no board id/);
  });

  it('--only scopes to the named boards', async () => {
    const f = fake();
    await configureOverviews(f.client, BOARD_IDS, false, SPECS, { only: ['organizations'] });
    expect(f.calls).toEqual([]);
  });
});

describe('overviewScope (--only handling)', () => {
  it('runs every board when --only is absent or names overviews', () => {
    expect(overviewScope(undefined)).toEqual({ run: true });
    expect(overviewScope(['overviews'])).toEqual({ run: true });
    expect(overviewScope(['dashboards', 'overviews'])).toEqual({ run: true });
  });
  it('scopes to the named boards, ignoring the dashboards keyword', () => {
    expect(overviewScope(['people-live', 'dashboards'])).toEqual({ run: true, boards: ['people-live'] });
  });
  it('does not run for --only dashboards alone', () => {
    expect(overviewScope(['dashboards'])).toEqual({ run: false });
  });
});

describe('parseRebuild', () => {
  const known = ['people-live', 'organizations'];
  it('is undefined when the flag is absent', () => { expect(parseRebuild(['--only', 'overviews'], known)).toBeUndefined(); });
  it('returns the board keys', () => { expect(parseRebuild(['--rebuild-overviews', 'people-live,organizations'], known)).toEqual({ keys: ['people-live', 'organizations'] }); });
  it('rejects a missing value, all, and unknown keys (Review Focus 6)', () => {
    expect(parseRebuild(['--rebuild-overviews'], known)).toMatchObject({ error: expect.stringMatching(/needs board keys/) });
    expect(parseRebuild(['--rebuild-overviews', '--dry-run'], known)).toMatchObject({ error: expect.stringMatching(/needs board keys/) });
    expect(parseRebuild(['--rebuild-overviews', 'all'], known)).toMatchObject({ error: expect.stringMatching(/never "all"/) });
    expect(parseRebuild(['--rebuild-overviews', 'people-live,nope'], known)).toMatchObject({ error: expect.stringMatching(/no Overview spec for nope/) });
  });
});

describe('decideOverview with rebuild', () => {
  it('replaces whatever Overview is on the board, adopted or complete', () => {
    expect(decideOverview({ viewId: 'v7', specNames: ['A'], rebuild: true })).toEqual({ kind: 'replace', viewId: 'v7', why: 'rebuild' });
    expect(decideOverview({ entry: { id: 'v7', widgets: { A: 'w1' }, complete: true }, viewId: 'v7', specNames: ['A'], rebuild: true }))
      .toEqual({ kind: 'replace', viewId: 'v7', why: 'rebuild' });
  });
  it('just creates when there is nothing to replace', () => {
    expect(decideOverview({ specNames: ['A'], rebuild: true })).toEqual({ kind: 'create' });
  });
});

describe('configureOverviews with rebuild', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });
  const kinds = (f: ReturnType<typeof fake>) => f.mutations().map((c) => (/delete_view/.test(c.query) ? 'delete' : /create_view/.test(c.query) ? 'view' : 'widget'));

  it('deletes a hand-built Overview first, then builds the full set, and says what is left to do by hand', async () => {
    const f = fake({ views: [{ id: 'v7', name: 'Overview' }] });
    const r = await configureOverviews(f.client, BOARD_IDS, false, SPECS, { rebuild: ['people-live'] });
    expect(kinds(f)).toEqual(['delete', 'view', 'widget', 'widget', 'widget']);
    expect(r.summary).toMatch(/replaced Overview on people-live/);
    expect(r.notes.join()).toMatch(/people-live: rebuilt — pin the new Overview first and re-size its widgets/);
    expect((await readJson<DashboardState>(STATE()))[KEY]!.complete).toBe(true);
  });

  it('replaces one that configure itself made and finished', async () => {
    await configureOverviews(fake().client, BOARD_IDS, false, SPECS);
    const f = fake({ views: [{ id: '101', name: 'Overview' }] });
    await configureOverviews(f.client, BOARD_IDS, false, SPECS, { rebuild: ['people-live'] });
    expect(kinds(f)).toEqual(['delete', 'view', 'widget', 'widget', 'widget']);
  });

  it('dry-run lists the replacement and makes no calls beyond reads', async () => {
    const f = fake({ views: [{ id: 'v7', name: 'Overview' }] });
    const r = await configureOverviews(f.client, BOARD_IDS, true, SPECS, { rebuild: ['people-live'] });
    expect(r.summary).toMatch(/would replace Overview on people-live \(3 widgets\)/);
    expect(f.mutations()).toEqual([]);
  });

  it('a refused plan never deletes the hand-built view it was going to replace', async () => {
    const f = fake({ views: [{ id: 'v7', name: 'Overview' }], columns: COLS.filter((c) => c.title !== 'This Year Amount') });
    const r = await configureOverviews(f.client, BOARD_IDS, false, SPECS, { rebuild: ['people-live'] });
    expect(f.mutations()).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('leaves boards not named in the rebuild list alone', async () => {
    const f = fake({ views: [{ id: 'v7', name: 'Overview' }] });
    await configureOverviews(f.client, BOARD_IDS, false, SPECS, { rebuild: ['organizations'] });
    expect(f.mutations().some((c) => /delete_view/.test(c.query))).toBe(false);
  });
});
