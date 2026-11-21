import { describe, expect, it } from 'vitest';
import { entryFor, formatDuration, isAnswered, pacificDate, type LoggableEvent } from './entry';

const call = (over: Partial<LoggableEvent> = {}): LoggableEvent => ({
  kind: 'call',
  occurredAt: '2026-11-19T18:00:00Z',
  direction: 'outbound',
  result: 'answered',
  talkSeconds: 725,
  staffName: 'Ann Staff',
  ...over,
});

describe('isAnswered', () => {
  it.each([
    [{ result: 'answered', talkSeconds: 0 }, true],
    [{ result: 'Call connected', talkSeconds: null }, true],
    [{ result: null, talkSeconds: 30 }, true],
    [{ result: 'voicemail', talkSeconds: 0 }, false],
    [{ result: 'no_answer', talkSeconds: 0 }, false],
    [{ result: 'No Answer', talkSeconds: null }, false],
    [{ result: 'missed', talkSeconds: 0 }, false],
    [{ result: null, talkSeconds: null }, false],
  ])('%j → %s', (over, expected) => {
    expect(isAnswered(call(over))).toBe(expected);
  });

  it('counts every text', () => {
    expect(isAnswered({ kind: 'text', result: null, talkSeconds: null })).toBe(true);
  });
});

describe('formatDuration', () => {
  it.each([[45, '45 sec'], [60, '1 min'], [725, '12 min'], [3600, '1 hr'], [3900, '1 hr 5 min']])('%i → %s', (s, text) => {
    expect(formatDuration(s)).toBe(text);
  });
});

describe('pacificDate', () => {
  it('uses the Pacific calendar day, not UTC', () => {
    expect(pacificDate('2026-11-20T06:30:00Z')).toBe('2026-11-19');
    expect(pacificDate('2026-11-20T09:00:00Z')).toBe('2026-11-20');
  });
});

describe('entryFor', () => {
  it('an answered call', () => {
    const entry = entryFor(call(), 'Jane Rider', null);
    expect(entry.title).toBe('Call with Jane Rider');
    expect(entry.summary).toBe('Outbound · 12 min');
    expect(entry.content).toBe("<p>Outbound call on Ann Staff's line, Nov 19, 2026, 10:00 AM PST, 12 min.</p>");
  });

  it('a missed inbound call to voicemail', () => {
    const entry = entryFor(call({ direction: 'inbound', result: 'voicemail', talkSeconds: 0 }), 'Jane Rider', null);
    expect(entry.title).toBe('Missed call from Jane Rider');
    expect(entry.summary).toBe('Inbound · voicemail');
    expect(entry.content).toContain(': voicemail.');
  });

  it('a missed outbound call with no answer', () => {
    const entry = entryFor(call({ result: 'no_answer', talkSeconds: 0 }), 'Jane Rider', null);
    expect(entry.title).toBe('Missed call to Jane Rider');
    expect(entry.summary).toBe('Outbound · no answer');
  });

  it('a text names the line and links to Zoom, with no message text', () => {
    const entry = entryFor(
      { kind: 'text', occurredAt: '2026-11-19T20:05:00Z', direction: 'inbound', result: null, talkSeconds: null, staffName: 'Ann Staff' },
      'Jane Rider',
      'https://zoom.us/sms?a=1&b=2',
    );
    expect(entry.title).toBe('Text from Jane Rider');
    expect(entry.summary).toBe("On Ann Staff's line");
    expect(entry.content).toContain('<a href="https://zoom.us/sms?a=1&amp;b=2">Open in Zoom</a>');
  });

  it('a text without smsUrl has no link', () => {
    const entry = entryFor({ ...call({ kind: 'text', result: null, talkSeconds: null }) }, 'Jane Rider', null);
    expect(entry.title).toBe('Text to Jane Rider');
    expect(entry.content).not.toContain('<a ');
  });

  it('escapes HTML and caps title and summary at 255 characters', () => {
    const entry = entryFor(call({ staffName: '<b>Ann</b>' }), 'J'.repeat(300), null);
    expect(entry.title).toHaveLength(255);
    expect(entry.title.endsWith('…')).toBe(true);
    expect(entry.content).toContain('&lt;b&gt;Ann&lt;/b&gt;');
  });

  it('falls back when Zoom gave no staff name', () => {
    expect(entryFor(call({ staffName: null }), 'Jane Rider', null).content).toContain('on a staff line');
  });
});
