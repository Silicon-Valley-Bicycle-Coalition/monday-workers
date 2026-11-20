// The Send event email link on an Events item, and which items need it rewritten. Pure and
// import-free so scripts/backfill-send-links-lib.mjs can re-export it through Node's type stripping;
// keep it strip-only TypeScript (no enums, namespaces, or constructor parameter properties).

export interface SendLink {
  url: string;
  text: string;
}

export interface EventLinkRow {
  itemId: string;
  eventbriteId: string;
  link: SendLink | null;
}

export interface SendLinkPlan {
  toWrite: { itemId: string; link: SendLink }[];
  current: number;
  notEventbrite: number;
}

// What mapEvent writes, and what the sweep and the backfill compare against.
export function sendLink(pageUrl: string, eventbriteId: string): SendLink {
  const sep = pageUrl.includes('?') ? '&' : '?';
  return { url: `${pageUrl}${sep}event=${encodeURIComponent(eventbriteId)}`, text: 'Send event email' };
}

// A link cell's stored value, or null when it's empty or not a link.
export function parseLink(raw: string | null | undefined): SendLink | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { url?: unknown; text?: unknown } | null;
    return typeof v?.url === 'string' ? { url: v.url, text: typeof v.text === 'string' ? v.text : '' } : null;
  } catch {
    return null;
  }
}

// Every Eventbrite event whose link is missing or differs from the current one (an older label, an
// older page URL); items without an Eventbrite id have no page to link to and are left alone.
export function planSendLinks(events: EventLinkRow[], pageUrl: string): SendLinkPlan {
  const plan: SendLinkPlan = { toWrite: [], current: 0, notEventbrite: 0 };
  for (const { itemId, eventbriteId, link } of events) {
    const id = (eventbriteId ?? '').trim();
    if (id === '') {
      plan.notEventbrite++;
      continue;
    }
    const want = sendLink(pageUrl, id);
    if (link && link.url === want.url && link.text === want.text) plan.current++;
    else plan.toWrite.push({ itemId, link: want });
  }
  return plan;
}
