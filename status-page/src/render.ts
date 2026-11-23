// The page itself: server-rendered HTML, no script. Every interpolated string goes through esc()
// (incident titles and watchdog details are vendor- or system-controlled text). Every state shows
// an icon and a word, never colour alone.

import { attentionItems } from './banner';
import type { CloudflareSection } from './cloudflare';
import { FONT_FACE_CSS } from './fonts';
import type { SyncRow, SyncSection, SyncState } from './syncs';
import { clockTime, relativeTime } from './time';
import type { Incident, Level } from './types';
import type { VendorRow } from './vendors';

export interface PageModel {
  syncs: SyncSection;
  cloudflare: CloudflareSection;
  vendors: VendorRow[];
  checkedAt: Date;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); // attributes are always double-quoted

type Tone = 'ok' | 'warn' | 'bad' | 'unknown' | 'none';
const LEVEL: Record<Level, { icon: string; word: string; tone: Tone }> = {
  operational: { icon: '✓', word: 'Operational', tone: 'ok' },
  degraded: { icon: '⚠', word: 'Degraded', tone: 'warn' },
  maintenance: { icon: '⚠', word: 'Maintenance', tone: 'warn' },
  outage: { icon: '✕', word: 'Outage', tone: 'bad' },
  unknown: { icon: '?', word: "Couldn't check", tone: 'unknown' },
  'link-only': { icon: '–', word: 'Status page only', tone: 'none' },
};
const SYNC: Record<SyncState, { icon: string; word: string; tone: Tone }> = {
  running: { icon: '✓', word: 'Running', tone: 'ok' },
  'not-running': { icon: '✕', word: 'Not running', tone: 'bad' },
  'backed-up': { icon: '⚠', word: 'Backed up', tone: 'warn' },
  paused: { icon: '⚠', word: 'Paused', tone: 'warn' },
  unknown: { icon: '?', word: "Couldn't check", tone: 'unknown' },
};

const badge = (s: { icon: string; word: string; tone: Tone }) =>
  `<span class="state state-${s.tone}"><span class="icon" aria-hidden="true">${s.icon}</span> ${esc(s.word)}</span>`;

const link = (url: string, label: string) => `<a href="${esc(url)}" rel="noopener noreferrer">${esc(label)}</a>`;

const incidentList = (incidents: Incident[]) =>
  incidents.length === 0
    ? ''
    : `<ul class="incidents">${incidents.map((i) => `<li>${i.url ? link(i.url, i.name) : esc(i.name)}</li>`).join('')}</ul>`;

function syncRow(r: SyncRow, now: Date): string {
  const note = r.lastRunAt ? ` <span class="muted">· last ran ${esc(relativeTime(r.lastRunAt, now))}</span>` : '';
  const details =
    r.details.length === 0
      ? ''
      : `<details><summary>Why</summary><ul>${r.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></details>`;
  return `<li class="row"><div class="name"><strong>${esc(r.label)}</strong><span class="muted">${esc(r.description)}</span></div><div class="status">${badge(SYNC[r.state])}${note}${details}</div></li>`;
}

function vendorRow(v: VendorRow): string {
  let status: string;
  if (v.level === 'link-only' && v.statusPageUrl && v.linkLabel) {
    status = `<span class="state state-none"><span class="icon" aria-hidden="true">–</span> No public status page</span> <span class="muted">· ${link(v.statusPageUrl, `${v.linkLabel} ↗`)}</span>`;
  } else if (v.level === 'link-only') {
    status = v.statusPageUrl
      ? `<span class="state state-none"><span class="icon" aria-hidden="true">–</span> ${link(v.statusPageUrl, 'Status page')} only</span>`
      : `<span class="state state-none"><span class="icon" aria-hidden="true">–</span> No public status page</span>`;
  } else {
    status = `${badge(LEVEL[v.level])}${v.statusPageUrl ? ` <span class="muted">${link(v.statusPageUrl, 'Status page ↗')}</span>` : ''}`;
  }
  return `<li class="row"><div class="name"><strong>${esc(v.name)}</strong><span class="muted">${esc(v.usedFor)}</span></div><div class="status">${status}${incidentList(v.incidents)}</div></li>`;
}

export function renderPage(model: PageModel, timezone: string): string {
  const { syncs, cloudflare, vendors, checkedAt } = model;
  const items = attentionItems(model, timezone);
  const banner =
    items.length === 0
      ? `<section class="banner banner-ok" aria-live="polite"><p><span aria-hidden="true">✓</span> All systems normal</p></section>`
      : `<section class="banner banner-attention" aria-live="polite"><p><span aria-hidden="true">⚠</span> ${items.length} ${items.length === 1 ? 'thing needs' : 'things need'} attention</p><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></section>`;

  const watchdogNote = syncs.stale
    ? syncs.runAt
      ? `The sync watchdog hasn't reported since ${esc(clockTime(syncs.runAt, timezone))}`
      : "The sync watchdog hasn't reported yet"
    : `watchdog checked ${esc(clockTime(syncs.runAt!, timezone))}`;

  const components = cloudflare.components
    .map((c) => `<li class="chip">${badge({ ...LEVEL[c.level], word: `${c.name}: ${LEVEL[c.level].word}` })}</li>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="120">
<meta name="robots" content="noindex">
<title>SVBC System Status</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="bar"><h1>SVBC System Status</h1><p>Checked ${esc(clockTime(checkedAt, timezone))}</p></header>
<main>
${banner}
<section aria-labelledby="syncs-h"><div class="section-head"><h2 id="syncs-h">SVBC syncs</h2><p class="muted">${watchdogNote}</p></div>
<ul class="rows">${syncs.rows.map((r) => syncRow(r, checkedAt)).join('')}</ul></section>
<section aria-labelledby="cf-h"><div class="section-head"><h2 id="cf-h">Cloudflare</h2><p class="muted">${link(cloudflare.statusPageUrl, 'cloudflarestatus.com ↗')}</p></div>
<ul class="chips">${components}</ul>${incidentList(cloudflare.incidents)}</section>
<section aria-labelledby="vendors-h"><div class="section-head"><h2 id="vendors-h">Services we use</h2></div>
<ul class="rows">${vendors.map(vendorRow).join('')}</ul></section>
</main>
<footer class="foot"><p>Silicon Valley Bicycle Coalition · staff only · refreshes every 2 minutes</p></footer>
</body>
</html>`;
}

// Tokens from docs/design-system/tokens.json. The status tones reuse its error, paid (amber) and
// map-dot-org (green) values; the design system has no dedicated success token.
export const STYLES_CSS = `${FONT_FACE_CSS}
:root {
  --svbc-black: #000000; --svbc-gold: #ffc700; --svbc-white: #ffffff; --svbc-chrome: #383838;
  --bg: #ffffff; --text: #303030; --text-muted: #666666; --surface: #ffffff; --sand: #f4f4f3;
  --border: #cccccc; --table-border: #eeeeee;
  --ok: #15803d; --warn-fg: #92400e; --warn-bg: #fef3c7; --bad-fg: #b91c1c; --bad-bg: #fef2f2;
  --font-heading: "Manrope", system-ui, sans-serif; --font-body: "Poppins", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1b1b; --text: #ececec; --text-muted: #b8b8b8; --surface: #2a2828; --sand: #242222;
    --border: #4d4a4a; --table-border: #3a3838;
    --ok: #4ade80; --warn-fg: #fcd34d; --warn-bg: #3b2f0a; --bad-fg: #fca5a5; --bad-bg: #3b1010;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 400 16px/1.5 var(--font-body); }
a { color: inherit; text-underline-offset: 2px; }
a:focus-visible { outline: 3px solid var(--svbc-gold); outline-offset: 2px; }
h1, h2 { font-family: var(--font-heading); font-weight: 500; letter-spacing: -0.02em; margin: 0; }
.bar { background: var(--svbc-black); color: var(--svbc-white); display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: baseline; justify-content: space-between; padding: 20px 16px; }
.bar h1 { font-size: 24.64px; }
.bar p { margin: 0; color: #cfcfcf; }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
section { margin-bottom: 32px; }
.section-head { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: baseline; justify-content: space-between; border-bottom: 2px solid var(--svbc-gold); padding-bottom: 6px; margin-bottom: 8px; }
.section-head h2 { font-size: 24.64px; }
.section-head p { margin: 0; }
.muted { color: var(--text-muted); font-size: 14px; }
.banner { border-radius: 8px; padding: 14px 18px; }
.banner p { margin: 0; font-weight: 600; }
.banner ul { margin: 8px 0 0; padding-left: 20px; }
.banner-ok { background: var(--sand); color: var(--ok); }
.banner-attention { background: var(--warn-bg); color: var(--warn-fg); }
.rows { list-style: none; margin: 0; padding: 0; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4px 16px; padding: 12px 0; border-bottom: 1px solid var(--table-border); }
.name { display: flex; flex-direction: column; }
.status { overflow-wrap: anywhere; }
.state { font-weight: 600; white-space: nowrap; }
.state-ok { color: var(--ok); }
.state-warn { color: var(--warn-fg); }
.state-bad { color: var(--bad-fg); }
.state-unknown, .state-none { color: var(--text-muted); }
.chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.chip { background: var(--sand); border: 1px solid var(--table-border); border-radius: 999px; padding: 4px 12px; font-size: 14px; }
.chip .state { white-space: normal; }
.incidents { margin: 6px 0 0; padding-left: 18px; font-size: 14px; }
details { margin-top: 4px; font-size: 14px; }
details ul { margin: 4px 0 0; padding-left: 18px; }
summary { cursor: pointer; color: var(--text-muted); }
.foot { background: var(--svbc-chrome); color: var(--svbc-white); padding: 16px; text-align: center; font-size: 14px; }
.foot p { margin: 0; }
@media (max-width: 600px) { .row { grid-template-columns: 1fr; } }
`;
