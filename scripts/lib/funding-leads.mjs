// Funding Leads board: the board spec, the sandbox guard and (below) the sheet-row mapping.
// Design: docs/superpowers/specs/2026-11-11-funding-leads-board-design.md
// Pure functions only; the CLI is scripts/funding-leads-board.mjs.

export const SANDBOX_WORKSPACE_ID = 18210301;

/** Throws unless `workspaceId` is the CRM Sandbox v4 workspace. Called before any request. */
export function assertSandboxWorkspace(workspaceId) {
  if (Number(workspaceId) !== SANDBOX_WORKSPACE_ID)
    throw new Error(`funding-leads is sandbox only (workspace ${SANDBOX_WORKSPACE_ID}); refusing ${workspaceId}`);
}

export const TYPES = ['Grant', 'Contract', 'Sponsorship'];
export const EVENTS = ['BTWD', 'Advocacy Summit', 'Dinner', 'Fundraising Ride', 'Wellness', 'Misc'];
export const BTWD_TIERS = ['Local', 'Regional'];
export const FUNDER_STATUSES = ['New', 'Renewal', 'Lapsed'];

export const STAGES = [
  { label: 'Research', done: false },
  { label: 'Needs Cultivation', done: false },
  { label: 'Cultivation', done: false },
  { label: 'Scheduled Meeting', done: false },
  { label: 'Proposal Submitted', done: false },
  { label: 'Evaluation', done: false },
  { label: 'Pledged', done: true },
  { label: 'Lost', done: false },
];

const labels = (values) => values.map((label) => ({ label }));

export const LEADS_COLUMNS = [
  { title: 'Organization', type: 'board_relation' },
  { title: 'Contact', type: 'board_relation' },
  { title: 'Amount', type: 'numbers', settings: { unit: { symbol: '$', direction: 'left' } } },
  { title: 'Owner', type: 'people' },
  { title: 'Expected Close', type: 'date' },
  { title: 'Type', type: 'dropdown', settings: { labels: labels(TYPES) } },
  { title: 'Events of interest', type: 'dropdown', settings: { labels: labels(EVENTS) } },
  { title: 'BTWD tier', type: 'status', settings: { labels: labels(BTWD_TIERS) } },
  { title: 'Funder Status', type: 'status', settings: { labels: labels(FUNDER_STATUSES) } },
  { title: 'Stage', type: 'status', settings: { labels: STAGES } },
  { title: 'Deal', type: 'board_relation' },
];

export const DEAL_EXTRA_COLUMNS = [
  { title: 'Type', type: 'dropdown', settings: { labels: labels(TYPES) } },
  { title: 'Events of interest', type: 'dropdown', settings: { labels: labels(EVENTS) } },
  { title: 'Lead', type: 'board_relation' },
  {
    title: 'Invoice Status',
    type: 'status',
    settings: { labels: labels(['Not Invoiced', 'Invoice Requested', 'Invoiced', 'Paid']) },
  },
  { title: 'PO Number', type: 'text' },
];

// ---- Sponsor-sheet mapping -------------------------------------------------------------------

const EVENT_PATTERNS = [
  [/btwd|bike to wherever/i, 'BTWD'],
  [/summit/i, 'Advocacy Summit'],
  [/dinner/i, 'Dinner'],
  [/ride/i, 'Fundraising Ride'],
  [/wellness/i, 'Wellness'],
  [/misc/i, 'Misc'],
];

/** "2024 BTWD; 2024 Advocacy Summit" or "2018 BTWD / Dinner" → EVENTS values, deduped, unknowns dropped. */
export function parseEvents(cycle) {
  const found = [];
  for (const token of String(cycle ?? '').split(/[;,/]/)) {
    const hit = EVENT_PATTERNS.find(([re]) => re.test(token));
    if (hit && !found.includes(hit[1])) found.push(hit[1]);
  }
  return found;
}

/** Comparison key for an organization name: no case, backslash escapes or repeated spaces. */
export function normalizeOrgName(name) {
  return String(name ?? '')
    .replace(/\\/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function parseEmails(cell) {
  return String(cell ?? '')
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter((e) => e.includes('@'));
}

const text = (v) => String(v ?? '').trim();
const contact = (name, emailCell) => {
  const emails = parseEmails(emailCell);
  return name || emails.length ? [{ name, emails }] : [];
};

/**
 * One sheet row → the lead it should become. `tab` is 'active' (2026 BTWD, Summit, Misc),
 * 'prospects' or 'lapsed'; keys are the sheet's column headings.
 */
export function mapSheetRow(tab, row) {
  const base = { types: ['Sponsorship'], btwdTier: null, funderStatus: null, amount: null, owners: [] };
  if (tab === 'active') {
    const org = text(row.Company);
    const tier = text(row.Type);
    const amount = text(row['Grant Amount']);
    return {
      ...base,
      orgName: org,
      orgKey: normalizeOrgName(org),
      name: org,
      events: parseEvents(row.Event),
      btwdTier: BTWD_TIERS.includes(tier) ? tier : null,
      stage: /^true$/i.test(text(row['Scheduled Meeting'])) ? 'Scheduled Meeting' : 'Research',
      amount: amount === '' || Number.isNaN(Number(amount)) ? null : Number(amount),
      owners: text(row['Staff Lead']).split(',').map(text).filter(Boolean),
      contacts: contact(
        [text(row['Primary Contact (First Name)']), text(row['(Last Name)'])].filter(Boolean).join(' '),
        row.Email,
      ),
    };
  }
  if (tab === 'prospects') {
    const org = text(row['Account Name']);
    return {
      ...base,
      orgName: org,
      orgKey: normalizeOrgName(org),
      name: org,
      events: parseEvents(row['Sponsorship Cycle']),
      stage: 'Needs Cultivation',
      contacts: contact(text(row['Primary Contact']), row['Contact: Email']),
    };
  }
  if (tab === 'lapsed') {
    const org = text(row.Company);
    return {
      ...base,
      orgName: org,
      orgKey: normalizeOrgName(org),
      name: org,
      events: parseEvents(row['Type of sponsorship']),
      stage: 'Lost',
      funderStatus: 'Lapsed',
      contacts: contact([text(row.Name), text(row['last name'])].filter(Boolean).join(' '), row['Email Address']),
    };
  }
  throw new Error(`unknown sheet tab: ${tab}`);
}
