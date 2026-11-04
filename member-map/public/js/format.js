// Pure text helpers for the map page. Plain ES module, no build step; unit-tested under vitest.
// Every string that came from Monday (names) goes through escapeHtml before it reaches HTML.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Link to a Monday item, or null when any part doesn't look like a real account URL or id. */
export function mondayUrl(accountUrl, boardId, itemId) {
  const base = String(accountUrl ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(base)) return null;
  if (!/^\d+$/.test(String(boardId)) || !/^\d+$/.test(String(itemId))) return null;
  return `${base}/boards/${boardId}/pulses/${itemId}`;
}

const count = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function miles(n) {
  if (n > 0 && n < 0.05) return 'under 0.1 mi';
  return `${n.toFixed(1)} mi`;
}

function bikeClause(props) {
  if (props.bikeDensity === null || props.bikeDensity === undefined) return 'no street miles';
  const m = props.bikeMiles;
  const total = m['1'] + m['2'] + m['3'] + m['4'];
  if (total <= 0) return 'no bike facilities';
  const pct = Math.round(props.bikeDensity * 100);
  const share = pct === 0 ? 'under 1%' : `${pct}%`;
  const classIV = m['4'] > 0 ? `, ${miles(m['4'])} Class IV` : '';
  return `bike facilities on ${share} of street miles (weighted; ${miles(total)}${classIV})`;
}

/** One line for a block group's popup: people, income, EPC, bike facilities. */
export function blockGroupSummary(props, counts) {
  const { members = 0, lapsed = 0, never = 0 } = counts ?? {};
  const parts = [
    count(props.population, 'resident', 'residents'),
    count(members, 'member', 'members'),
    `${count(lapsed + never, 'warm lead', 'warm leads')} (${lapsed.toLocaleString('en-US')} lapsed, ${count(never, 'never member', 'never members')})`,
    props.medianIncome === null || props.medianIncome === undefined
      ? 'median income not reported'
      : `median household income $${Math.round(props.medianIncome / 1000).toLocaleString('en-US')}k`,
  ];
  if (props.epc) parts.push('Equity Priority Community');
  parts.push(bikeClause(props));
  return parts.join(' · ');
}

const AS_OF = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric',
});

/** "Data as of Nov 2, 2026 · 212 people with no usable address" (date in Pacific time). */
export function statusLine(snapshot) {
  const line = `Data as of ${AS_OF.format(new Date(snapshot.asOf))}`;
  if (!snapshot.unplaced) return line;
  return `${line} · ${count(snapshot.unplaced, 'person', 'people')} with no usable address`;
}

const KIND_LABELS = { member: 'Member', lapsed: 'Lapsed member', never: 'Never a member', org: 'Organization' };

export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? 'Unknown';
}

/** Popup HTML for one dot: escaped name, kind, Do Not Solicit flag, and a Monday link when the ids are sane. */
export function pointPopupHtml(point, accountUrl) {
  const lines = [`<strong>${escapeHtml(point.name)}</strong>`, escapeHtml(kindLabel(point.kind))];
  if (point.dns) lines.push('<span class="dns">Do Not Solicit</span>');
  const url = mondayUrl(accountUrl, point.boardId, point.id);
  if (url) lines.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener">Open in Monday</a>`);
  return lines.join('<br>');
}
