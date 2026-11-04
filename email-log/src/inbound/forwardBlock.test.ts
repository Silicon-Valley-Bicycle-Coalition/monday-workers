import { describe, expect, it } from 'vitest';
import { parseAddressList, parseForwardBlock } from './forwardBlock';

const TZ = 'America/Los_Angeles';

const gmail = (date = 'Mon, Oct 19, 2026 at 3:04 PM') => `FYI, see below.

---------- Forwarded message ---------
From: Jane Rider <Jane@Example.org>
Date: ${date}
Subject: Trail closure
To: Dana <dana@bikesiliconvalley.org>, "Doe, John" <john@example.com>
Cc: bare@example.net

Hello Dana,
The trail is closed.`;

describe('parseForwardBlock', () => {
  it('parses a Gmail forwarded block', () => {
    expect(parseForwardBlock(gmail(), TZ)).toEqual({
      from: 'jane@example.org',
      to: ['dana@bikesiliconvalley.org', 'john@example.com'],
      cc: ['bare@example.net'],
      subject: 'Trail closure',
      dateISO: '2026-10-19T22:04:00.000Z',
      messageId: null,
      body: 'Hello Dana,\nThe trail is closed.',
    });
  });

  it('joins wrapped To lines and accepts a Message-ID line', () => {
    const text = `---------- Forwarded message ---------
From: a@example.org
Subject: S
Message-ID: <abc@example.org>
To: b@example.org,
 c@example.org

body`;
    const block = parseForwardBlock(text, TZ)!;
    expect(block.to).toEqual(['b@example.org', 'c@example.org']);
    expect(block.messageId).toBe('<abc@example.org>');
  });

  it('joins an un-indented To continuation after a trailing comma', () => {
    const text = `---------- Forwarded message ---------
From: a@example.org
To: b@example.org,
c@example.org
Subject: S

body`;
    const block = parseForwardBlock(text, TZ)!;
    expect(block.to).toEqual(['b@example.org', 'c@example.org']);
    expect(block.subject).toBe('S');
    expect(block.body).toBe('body');
  });

  it('keeps the first body line when the header block has no blank line', () => {
    const text = `---------- Forwarded message ---------
From: a@example.org
Subject: S
Hello there, this is the body
second line`;
    expect(parseForwardBlock(text, TZ)!.body).toBe('Hello there, this is the body\nsecond line');
  });

  it('returns null when the block has no parseable From', () => {
    expect(parseForwardBlock('---------- Forwarded message ---------\nFrom: undisclosed\nSubject: S\n\nbody', TZ)).toBeNull();
    expect(parseForwardBlock('---------- Forwarded message ---------\nSubject: S\n\nbody', TZ)).toBeNull();
  });

  it('accepts a date without a weekday and handles PST', () => {
    expect(parseForwardBlock(gmail('Jan 5, 2026 at 12:00 AM'), TZ)!.dateISO).toBe('2026-01-05T08:00:00.000Z');
  });

  it('returns dateISO null for an unparseable Date', () => {
    expect(parseForwardBlock(gmail('last Tuesday-ish'), TZ)!.dateISO).toBeNull();
    expect(parseForwardBlock(gmail('Mon, Oct 19, 2026 at 3:4 PM'), TZ)!.dateISO).toBeNull();
  });

  it('returns null when there is no block', () => {
    expect(parseForwardBlock('just a plain email', TZ)).toBeNull();
  });

  it('takes the first block of a nested forward', () => {
    const text = `${gmail()}

---------- Forwarded message ---------
From: Inner <inner@example.org>
Subject: Inner

inner body`;
    const block = parseForwardBlock(text, TZ)!;
    expect(block.from).toBe('jane@example.org');
    expect(block.body).toContain('---------- Forwarded message ---------');
    expect(block.body).toContain('inner body');
  });
});

const apple = (date = 'November 2, 2026 at 13:58:55 PST', quote = '> ') => `FYI, see below.

${quote}Begin forwarded message:
${quote.trimEnd()}
${quote}From: Jane Rider <Jane@Example.org>
${quote}Subject: Trail closure
${quote}Date: ${date}
${quote}To: Dana <dana@bikesiliconvalley.org>, "Doe, John" <john@example.com>
${quote}Cc: bare@example.net
${quote}Reply-To: support@example.org
${quote.trimEnd()}
${quote}Hello Dana,
${quote}> Earlier quote
${quote}The trail is closed.`;

describe('parseForwardBlock (Apple Mail)', () => {
  it('parses a "> "-quoted Apple Mail block', () => {
    expect(parseForwardBlock(apple(), TZ)).toEqual({
      from: 'jane@example.org',
      to: ['dana@bikesiliconvalley.org', 'john@example.com'],
      cc: ['bare@example.net'],
      subject: 'Trail closure',
      dateISO: '2026-11-02T21:58:55.000Z',
      messageId: null,
      body: 'Hello Dana,\n> Earlier quote\nThe trail is closed.',
    });
  });

  it('parses an unquoted Apple Mail block the same way', () => {
    expect(parseForwardBlock(apple(undefined, ''), TZ)).toEqual(parseForwardBlock(apple(), TZ));
  });

  it('removes only the quote level the marker sits at', () => {
    const block = parseForwardBlock(apple(undefined, '> > '), TZ)!;
    expect(block.from).toBe('jane@example.org');
    expect(block.body).toBe('Hello Dana,\n> Earlier quote\nThe trail is closed.');
  });

  it("reads the Date line's own zone, not forwardTimeZone", () => {
    expect(parseForwardBlock(apple('November 2, 2026 at 13:58:55 PST'), 'America/New_York')!.dateISO).toBe('2026-11-02T21:58:55.000Z');
    expect(parseForwardBlock(apple('October 19, 2026 at 15:04:00 PDT'), TZ)!.dateISO).toBe('2026-10-19T22:04:00.000Z');
    expect(parseForwardBlock(apple('October 19, 2026 at 22:04:00 GMT'), TZ)!.dateISO).toBe('2026-10-19T22:04:00.000Z');
    expect(parseForwardBlock(apple('October 20, 2026 at 00:04:00 GMT+2'), TZ)!.dateISO).toBe('2026-10-19T22:04:00.000Z');
    expect(parseForwardBlock(apple('October 20, 2026 at 03:34:00 GMT+05:30'), TZ)!.dateISO).toBe('2026-10-19T22:04:00.000Z');
  });

  it('accepts a weekday, a 12-hour clock (narrow no-break space too), and no seconds', () => {
    expect(parseForwardBlock(apple('Monday, November 2, 2026 at 1:58:55 PM PST'), TZ)!.dateISO).toBe('2026-11-02T21:58:55.000Z');
    expect(parseForwardBlock(apple('November 2, 2026 at 1:58:55\u202fPM PST'), TZ)!.dateISO).toBe('2026-11-02T21:58:55.000Z');
    expect(parseForwardBlock(apple('Nov 2, 2026 at 13:58 PST'), TZ)!.dateISO).toBe('2026-11-02T21:58:00.000Z');
  });

  it('reads a zoneless Apple date in forwardTimeZone', () => {
    expect(parseForwardBlock(apple('November 2, 2026 at 13:58:55'), TZ)!.dateISO).toBe('2026-11-02T21:58:55.000Z');
  });

  it('returns dateISO null for an unknown zone or a bad date', () => {
    expect(parseForwardBlock(apple('November 2, 2026 at 13:58:55 XYZT'), TZ)!.dateISO).toBeNull();
    expect(parseForwardBlock(apple('Novembr 2, 2026 at 13:58:55 PST'), TZ)!.dateISO).toBeNull();
    expect(parseForwardBlock(apple('February 30, 2026 at 13:58:55 PST'), TZ)!.dateISO).toBeNull();
    expect(parseForwardBlock(apple('November 2, 2026 at 24:00:00 PST'), TZ)!.dateISO).toBeNull();
    expect(parseForwardBlock(apple('November 2, 2026 at 13:58:55 PM PST'), TZ)!.dateISO).toBeNull();
  });

  it('takes whichever block comes first when Gmail and Apple blocks are nested', () => {
    const block = parseForwardBlock(`${apple()}\n> \n${gmail().replace(/^/gm, '> ')}`, TZ)!;
    expect(block.dateISO).toBe('2026-11-02T21:58:55.000Z');
    expect(block.body).toContain('---------- Forwarded message ---------');
  });

  it('returns null when the Apple block has no parseable From', () => {
    expect(parseForwardBlock('> Begin forwarded message:\n>\n> Subject: S\n>\n> body', TZ)).toBeNull();
  });
});

describe('parseAddressList', () => {
  it('parses an address list with a quoted comma', () => {
    expect(parseAddressList('Jane Rider <jane@example.org>, "Doe, John" <John@example.com>, bare@example.net')).toEqual([
      'jane@example.org',
      'john@example.com',
      'bare@example.net',
    ]);
  });

  it('extracts a bare address after a display name without brackets', () => {
    expect(parseAddressList('Jane Rider jane@example.org, "(bob@example.com)"')).toEqual(['jane@example.org', 'bob@example.com']);
  });

  it('drops entries without an address', () => {
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([]);
    expect(parseAddressList('Jane, a@example.org')).toEqual(['a@example.org']);
  });

  it('returns [] for an empty list', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList('  ')).toEqual([]);
  });
});
