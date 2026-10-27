import type { DigestKey, DigestsConfig } from './config';
import type { Board, DigestsMondayClient, Item, Rule } from './monday/client';
import { addDays, fiscalYear, thisAndNextMonth, type LocalTime } from './schedule';

// The five digests that replace SVBC's seven Salesforce report subscriptions (monday-migration
// docs/35 §3.6). Each queries the same rules as the board view it links to, so the email and the
// view agree; the view is where staff work the list.

export interface Table { headers: string[]; rows: string[][]; more: number }
export interface Section { heading: string; note?: string; table: Table | null; empty: string }
export interface Digest { subject: string; intro: string; sections: Section[]; count: number; viewUrl: string | null }

// Board column titles. Titles, not ids: ids differ between the sandbox and production boards.
const D = { donor: 'Donor', amount: 'Amount', date: 'Date', giftType: 'Gift Type', stream: 'Funding Stream', size: 'Gift Size', status: 'Status', anonymous: 'Anonymous Donor' };
const P = { email: 'Personal Email', phone: 'Phone', status: 'Membership Status', tier: 'Membership Tier', until: 'Member Until' };
// Read from each gift's Donor item. The Windfall columns exist only on the two People boards
// (monday-workers!230) and are frozen at migration; an Organizations donor shows them blank.
const WEALTH = ['Net Worth', 'Philanthropic Giver', 'Job Title', 'Windfall Company', 'Lifetime Giving', 'Donor Level'];

// Rows past this go to the view instead of the email.
export const MAX_ROWS = 150;

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const formatMoney = (n: number) => money.format(n);
const amountOf = (text: string | null | undefined) => {
  const n = Number(text ?? '');
  return text === null || text === undefined || text === '' || !Number.isFinite(n) ? 0 : n;
};

function columnIds(board: Board, titles: string[]): Map<string, string> {
  const ids = new Map<string, string>();
  const missing: string[] = [];
  for (const title of titles) {
    const col = board.columns.find((c) => c.title === title);
    if (col) ids.set(title, col.id);
    else missing.push(title);
  }
  if (missing.length > 0) throw new Error(`board "${board.name}" has no column ${missing.map((t) => `"${t}"`).join(', ')}`);
  return ids;
}

function table(headers: string[], rows: string[][]): Table {
  return { headers, rows: rows.slice(0, MAX_ROWS), more: Math.max(0, rows.length - MAX_ROWS) };
}

interface Context {
  monday: DigestsMondayClient;
  config: DigestsConfig;
  now: LocalTime;
}

async function loadBoard(ctx: Context, which: 'donations' | 'people'): Promise<Board> {
  const id = ctx.config.boards[which];
  const board = id === 0 ? null : await ctx.monday.getBoard(id);
  if (board === null) throw new Error(`${which} board ${id} is not visible (still a placeholder?)`);
  return board;
}

function viewUrl(ctx: Context, board: Board, viewName: string): string | null {
  const view = board.views.find((v) => v.name === viewName);
  // Without the view (configure not run yet) the email still goes out, linking the board.
  return view ? `${ctx.config.monday.accountUrl}/boards/${board.id}/views/${view.id}` : `${ctx.config.monday.accountUrl}/boards/${board.id}`;
}

const giftRow = (item: Item, ids: Map<string, string>) => [
  item.text.get(ids.get(D.date)!) ?? '',
  item.text.get(ids.get(D.donor)!) ?? '',
  formatMoney(amountOf(item.text.get(ids.get(D.amount)!))),
  item.text.get(ids.get(D.giftType)!) ?? '',
  item.text.get(ids.get(D.stream)!) ?? '',
];
const GIFT_HEADERS = ['Date', 'Donor', 'Amount', 'Gift Type', 'Funding Stream'];

// From `from` through today: a pledge or sponsorship dated in the future isn't a gift yet.
const dateRange = (ids: Map<string, string>, from: string, today: string): Rule[] => [
  { column_id: ids.get(D.date)!, operator: 'greater_than_or_equals', compare_value: ['EXACT', from] },
  { column_id: ids.get(D.date)!, operator: 'lower_than_or_equal', compare_value: ['EXACT', today] },
];

const byDateDesc = (ids: Map<string, string>) => (a: Item, b: Item) =>
  (b.text.get(ids.get(D.date)!) ?? '').localeCompare(a.text.get(ids.get(D.date)!) ?? '');

// "Funraise Opps with no Account": gifts with no Donor that aren't marked anonymous — the
// 'Needs a donor' view's rules. Every source lands here, not only Funraise.
async function unmatchedGifts(ctx: Context): Promise<Digest> {
  const board = await loadBoard(ctx, 'donations');
  const ids = columnIds(board, Object.values(D));
  const rules: Rule[] = [
    { column_id: ids.get(D.donor)!, operator: 'is_empty', compare_value: [] },
    { column_id: ids.get(D.anonymous)!, operator: 'is_empty', compare_value: [] },
  ];
  const items = (await ctx.monday.queryItems(Number(board.id), rules, [...ids.values()])).sort(byDateDesc(ids));
  return {
    subject: `Gifts with no donor: ${items.length}`,
    intro: 'These gifts have no Donor and aren’t marked Anonymous Donor, so they count toward nobody’s giving. ' +
      'Link each one to its person or organization, or check Anonymous Donor.',
    sections: [{ heading: 'Gifts with no donor', table: items.length ? table(GIFT_HEADERS, items.map((i) => giftRow(i, ids))) : null, empty: 'None.' }],
    count: items.length,
    viewUrl: viewUrl(ctx, board, ctx.config.digests['unmatched-gifts'].view),
  };
}

// "Renewals for Current and Next Month": Member Until from the 1st of this month to the end of
// next month, Active or already Lapsed this month.
async function renewals(ctx: Context): Promise<Digest> {
  const board = await loadBoard(ctx, 'people');
  const ids = columnIds(board, Object.values(P));
  const { from, to } = thisAndNextMonth(ctx.now);
  const rules: Rule[] = [
    { column_id: ids.get(P.until)!, operator: 'greater_than_or_equals', compare_value: ['EXACT', from] },
    { column_id: ids.get(P.until)!, operator: 'lower_than_or_equal', compare_value: ['EXACT', to] },
  ];
  const items = (await ctx.monday.queryItems(Number(board.id), rules, [...ids.values()]))
    .sort((a, b) => (a.text.get(ids.get(P.until)!) ?? '').localeCompare(b.text.get(ids.get(P.until)!) ?? ''));
  const rows = items.map((i) => [
    i.text.get(ids.get(P.until)!) ?? '', i.name, i.text.get(ids.get(P.status)!) ?? '', i.text.get(ids.get(P.tier)!) ?? '',
    i.text.get(ids.get(P.email)!) ?? '', i.text.get(ids.get(P.phone)!) ?? '',
  ]);
  return {
    subject: `Membership renewals, ${from.slice(0, 7)} and ${to.slice(0, 7)}: ${items.length}`,
    intro: `Members whose membership ends between ${from} and ${to}.`,
    sections: [{ heading: 'Renewals due', table: rows.length ? table(['Member Until', 'Name', 'Status', 'Tier', 'Email', 'Phone'], rows) : null, empty: 'No memberships end this month or next.' }],
    count: items.length,
    viewUrl: viewUrl(ctx, board, ctx.config.digests.renewals.view),
  };
}

// "$400+ Donations + Windfall Last 60 Days" and "Wealth Screen on Donations-Last 60 Days", one
// email: gifts from the last N days with each donor's Windfall screening alongside.
async function recentGiftsWealth(ctx: Context): Promise<Digest> {
  const cfg = ctx.config.digests['recent-gifts-wealth'];
  const board = await loadBoard(ctx, 'donations');
  const ids = columnIds(board, Object.values(D));
  const since = addDays(ctx.now.date, -cfg.days!);
  const rules = dateRange(ids, since, ctx.now.date);
  const items = (await ctx.monday.queryItems(Number(board.id), rules, [...ids.values()]))
    .filter((i) => (i.text.get(ids.get(D.status)!) ?? '').startsWith('Received'))
    .sort((a, b) => amountOf(b.text.get(ids.get(D.amount)!)) - amountOf(a.text.get(ids.get(D.amount)!)));

  const donorIds = [...new Set(items.flatMap((i) => i.linked.get(ids.get(D.donor)!) ?? []))];
  const donors = new Map((await ctx.monday.getItemsByTitle(donorIds)).map((d) => [d.id, d]));
  const wealthOf = (item: Item) => {
    const donor = donors.get((item.linked.get(ids.get(D.donor)!) ?? [])[0] ?? '');
    return WEALTH.map((title) => {
      const v = donor?.byTitle.get(title) ?? null;
      return v !== null && (title === 'Net Worth' || title === 'Lifetime Giving') ? formatMoney(amountOf(v)) : (v ?? '');
    });
  };
  const screened = (item: Item) => wealthOf(item)[0] !== '';
  const row = (i: Item) => [...giftRow(i, ids).slice(0, 4), ...wealthOf(i)];
  const headers = [...GIFT_HEADERS.slice(0, 4), ...WEALTH];

  const min = cfg.minAmount!;
  const big = items.filter((i) => amountOf(i.text.get(ids.get(D.amount)!)) >= min);
  const smallScreened = items.filter((i) => amountOf(i.text.get(ids.get(D.amount)!)) < min && screened(i));
  return {
    subject: `Gifts in the last ${cfg.days} days, with wealth screening: ${big.length} of ${formatMoney(min)}+`,
    intro: `Received gifts dated ${since} through ${ctx.now.date}, largest first, with the donor’s Windfall screening from People. ` +
      'Windfall data is frozen at migration; Organizations donors have none.',
    sections: [
      { heading: `${formatMoney(min)} and up`, table: big.length ? table(headers, big.map(row)) : null, empty: `No gifts of ${formatMoney(min)} or more.` },
      { heading: `Under ${formatMoney(min)}, screened donors`, note: 'Donors with a Windfall Net Worth on file.',
        table: smallScreened.length ? table(headers, smallScreened.map(row)) : null, empty: 'None.' },
    ],
    count: big.length + smallScreened.length,
    viewUrl: viewUrl(ctx, board, cfg.view),
  };
}

// "Current FY Opps (no contacts)": this fiscal year's received gifts, totalled by Gift Size.
async function fiscalYearBySize(ctx: Context): Promise<Digest> {
  const board = await loadBoard(ctx, 'donations');
  const ids = columnIds(board, Object.values(D));
  const fy = fiscalYear(ctx.now);
  const rules = dateRange(ids, fy.start, ctx.now.date);
  const items = (await ctx.monday.queryItems(Number(board.id), rules, [...ids.values()]))
    .filter((i) => (i.text.get(ids.get(D.status)!) ?? '').startsWith('Received'));
  const bands = new Map<string, { count: number; total: number }>();
  for (const i of items) {
    const band = i.text.get(ids.get(D.size)!) ?? 'No size yet';
    const b = bands.get(band) ?? { count: 0, total: 0 };
    b.count += 1;
    b.total += amountOf(i.text.get(ids.get(D.amount)!));
    bands.set(band, b);
  }
  const total = [...bands.values()].reduce((s, b) => s + b.total, 0);
  const rows = [...bands.entries()].sort((a, b) => b[1].total - a[1].total)
    .map(([band, b]) => [band, String(b.count), formatMoney(b.total)]);
  if (rows.length) rows.push(['Total', String(items.length), formatMoney(total)]);
  return {
    subject: `${fy.label} to date: ${formatMoney(total)} from ${items.length} gifts`,
    intro: `Received gifts dated ${fy.start} through ${ctx.now.date}, by Gift Size.`,
    sections: [{ heading: `${fy.label} by gift size`, table: rows.length ? { headers: ['Gift Size', 'Gifts', 'Amount'], rows, more: 0 } : null, empty: 'No gifts yet this fiscal year.' }],
    count: items.length,
    viewUrl: viewUrl(ctx, board, ctx.config.digests['fiscal-year-by-size'].view),
  };
}

// "Donations Made in the Last Week".
async function lastWeek(ctx: Context): Promise<Digest> {
  const cfg = ctx.config.digests['last-week'];
  const board = await loadBoard(ctx, 'donations');
  const ids = columnIds(board, Object.values(D));
  const since = addDays(ctx.now.date, -cfg.days!);
  const rules = dateRange(ids, since, ctx.now.date);
  const items = (await ctx.monday.queryItems(Number(board.id), rules, [...ids.values()])).sort(byDateDesc(ids));
  const total = items.reduce((s, i) => s + amountOf(i.text.get(ids.get(D.amount)!)), 0);
  return {
    subject: `Gifts in the last ${cfg.days} days: ${items.length}, ${formatMoney(total)}`,
    intro: `Every gift dated ${since} through ${ctx.now.date}, newest first.`,
    sections: [{ heading: 'Gifts', table: items.length ? table([...GIFT_HEADERS, 'Status'], items.map((i) => [...giftRow(i, ids), i.text.get(ids.get(D.status)!) ?? ''])) : null, empty: 'No gifts.' }],
    count: items.length,
    viewUrl: viewUrl(ctx, board, cfg.view),
  };
}

export const BUILDERS: Record<DigestKey, (ctx: Context) => Promise<Digest>> = {
  'unmatched-gifts': unmatchedGifts,
  renewals,
  'recent-gifts-wealth': recentGiftsWealth,
  'fiscal-year-by-size': fiscalYearBySize,
  'last-week': lastWeek,
};

export function buildDigest(key: DigestKey, monday: DigestsMondayClient, config: DigestsConfig, now: LocalTime): Promise<Digest> {
  return BUILDERS[key]({ monday, config, now });
}
