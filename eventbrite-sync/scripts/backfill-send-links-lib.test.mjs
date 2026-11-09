import { describe, it, expect } from 'vitest';
import { planSendLinks, sendLink } from './backfill-send-links-lib.mjs';

const PAGE = 'https://example.org/classes';
const ev = (itemId, eventbriteId, link = null) => ({ itemId, eventbriteId, link });

describe('sendLink', () => {
  // Must match what mapEvent writes (src/mapping/event.test.ts, "Send event email link").
  it('is the page URL with the event id, labelled Send event email', () => {
    expect(sendLink(PAGE, '9001')).toEqual({ url: 'https://example.org/classes?event=9001', text: 'Send event email' });
    expect(sendLink(PAGE, 'a b&c')).toEqual({ url: 'https://example.org/classes?event=a%20b%26c', text: 'Send event email' });
    expect(sendLink(`${PAGE}?x=1`, '9001').url).toBe('https://example.org/classes?x=1&event=9001');
  });
});

describe('planSendLinks', () => {
  it('writes a link on every Eventbrite event that lacks one or has an old one', () => {
    const plan = planSendLinks([
      ev('1', '9001'),
      ev('2', '9002', { url: `${PAGE}?event=9002`, text: 'Send class email' }),
      ev('3', '9003', { url: `${PAGE}?event=9003`, text: 'Send event email' }),
      ev('4', ''),
    ], PAGE);
    expect(plan.toWrite).toEqual([
      { itemId: '1', link: sendLink(PAGE, '9001') },
      { itemId: '2', link: sendLink(PAGE, '9002') },
    ]);
    expect(plan.current).toBe(1);
    expect(plan.notEventbrite).toBe(1);
  });

  it('rewrites a link that points at another page', () => {
    const plan = planSendLinks([ev('1', '9001', { url: 'https://old.example/x?event=9001', text: 'Send event email' })], PAGE);
    expect(plan.toWrite).toHaveLength(1);
  });

  it('trims the Eventbrite id', () => {
    expect(planSendLinks([ev('1', ' 9001 ')], PAGE).toWrite[0].link.url).toBe(`${PAGE}?event=9001`);
  });
});
