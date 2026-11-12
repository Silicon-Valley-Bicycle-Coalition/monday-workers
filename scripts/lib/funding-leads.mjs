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
