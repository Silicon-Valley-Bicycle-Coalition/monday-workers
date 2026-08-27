import type { CalendarsConfig, SourceConfig } from './types';

export interface ListingRow {
  id: string;
  label: string;
  href: string;
}

export interface Listing {
  committees: ListingRow[];
  events: ListingRow[];
}

export function buildListing(config: CalendarsConfig, baseUrl: string): Listing {
  const toRow = (source: SourceConfig): ListingRow => ({
    id: source.id,
    label: source.adapter === 'eventbrite' ? source.committeeName : source.name,
    href: `${baseUrl}/calendars/${source.id}.ics`,
  });
  return {
    committees: config.sources.filter((s) => s.adapter !== 'eventbrite').map(toRow),
    events: config.sources.filter((s) => s.adapter === 'eventbrite').map(toRow),
  };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rowsHtml(rows: ListingRow[]): string {
  return rows.map((row) => `<li>${escapeHtml(row.label)}: <a href="${escapeHtml(row.href)}">${escapeHtml(row.href)}</a></li>`).join('');
}

export function buildListingHtml(listing: Listing, webAnalyticsToken: string): string {
  // No Subresource Integrity hash on this script deliberately: Cloudflare serves
  // beacon.min.js from its own edge and updates it without version pinning, so a pinned SRI
  // hash would break the beacon the next time Cloudflare ships an update. This is the standard,
  // documented way to load Cloudflare Web Analytics.
  const analyticsScript = webAnalyticsToken
    ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${webAnalyticsToken}"}'></script>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SVBC Bike Calendars</title>
${analyticsScript}
</head>
<body>
<h1>SVBC Bike Calendars</h1>
<p>Subscribe to just the calendars you care about. Copy a link below into Google/Apple Calendar, a web page, an email, or a social post.</p>
<h2>Committee Meetings</h2>
<ul>${rowsHtml(listing.committees)}</ul>
<h2>SVBC Events</h2>
<ul>${rowsHtml(listing.events)}</ul>
</body>
</html>`;
}
