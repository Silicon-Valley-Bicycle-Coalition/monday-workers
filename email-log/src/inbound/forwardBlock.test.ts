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
