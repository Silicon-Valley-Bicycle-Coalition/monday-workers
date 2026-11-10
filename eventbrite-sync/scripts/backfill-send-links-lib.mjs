// Pure planning for backfill-send-links.mjs: which Events items need the Send event email link.

// The link mapEvent (src/mapping/event.ts) writes. Kept in step by both test files, since a script
// can't import that module (its imports have no .ts extensions).
export function sendLink(pageUrl, eventbriteId) {
  const sep = pageUrl.includes('?') ? '&' : '?';
  return { url: `${pageUrl}${sep}event=${encodeURIComponent(eventbriteId)}`, text: 'Send event email' };
}

// events: [{ itemId, eventbriteId, link: { url, text } | null }]
export function planSendLinks(events, pageUrl) {
  const plan = { toWrite: [], current: 0, notEventbrite: 0 };
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
