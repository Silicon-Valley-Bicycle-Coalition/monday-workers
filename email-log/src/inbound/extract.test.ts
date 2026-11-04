import PostalMime from 'postal-mime';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../test/testConfig';
import { extract } from './extract';
import { messageIdHash } from './dedupe';
import bccNew from '../../test/fixtures/gmail-bcc-new.eml?raw';
import bccReply from '../../test/fixtures/gmail-bcc-reply.eml?raw';
import forward from '../../test/fixtures/gmail-forward.eml?raw';
import appleForward from '../../test/fixtures/apple-forward.eml?raw';
import forwardOwn from '../../test/fixtures/gmail-forward-own-sent.eml?raw';
import outlook from '../../test/fixtures/outlook-forward.eml?raw';
import staffOnly from '../../test/fixtures/staff-only.eml?raw';
import htmlOnly from '../../test/fixtures/html-only.eml?raw';
import noMessageId from '../../test/fixtures/no-message-id.eml?raw';
import logInTo from '../../test/fixtures/log-in-to.eml?raw';
import withAttachment from '../../test/fixtures/with-attachment.eml?raw';
import withInlineImage from '../../test/fixtures/with-inline-image.eml?raw';

const { mail } = testConfig({
  mail: { staffDomains: ['bikesiliconvalley.org'], loggingAddress: 'log@log.bikesiliconvalley.org' },
});
const NOW = new Date('2030-01-01T00:00:00.000Z');
const run = async (raw: string) => extract(await PostalMime.parse(raw), mail, NOW);
const logged = async (raw: string) => {
  const r = await run(raw);
  if (r.kind !== 'log') throw new Error('expected log');
  return r;
};

describe('extract', () => {
  it('bcc: counterparts are To + Cc', async () => {
    const r = await logged(bccNew);
    expect(r.message).toEqual({
      kind: 'bcc',
      counterparts: ['jane@example.org', 'bob@example.com', 'carol@example.net'],
      subject: 'Trail closure follow-up',
      dateISO: '2026-10-19T22:04:00.000Z',
      body: 'Hi Jane,\nThanks for the call.',
      attachmentNames: [],
    });
    expect(r.dedupeSource).toEqual({ messageId: '<bcc-new-1@mail.bikesiliconvalley.org>' });
  });

  it('bcc: cuts quoted history from the body', async () => {
    expect((await logged(bccReply)).message.body).toBe('Sounds good.');
  });

  it('excludes the logging address and staff from counterparts', async () => {
    expect((await logged(bccReply)).message.counterparts).toEqual(['jane@example.org']);
    expect((await logged(logInTo)).message.counterparts).toEqual(['jane@example.org']);
  });

  it('staff-only mail is staff-only', async () => {
    expect(await run(staffOnly)).toEqual({ kind: 'staff-only' });
  });

  it('does not treat a staff subdomain as staff', async () => {
    const raw = bccNew.replace('jane@example.org', 'x@log.bikesiliconvalley.org');
    expect((await logged(raw)).message.counterparts).toContain('x@log.bikesiliconvalley.org');
  });

  it('forward: counterparts are the block\'s From plus its non-staff Cc; subject loses "Fwd: "; date and body come from the block', async () => {
    const r = await logged(forward);
    expect(r.message).toEqual({
      kind: 'forward',
      counterparts: ['jane@example.org', 'bob@example.com'],
      subject: 'Trail closure',
      dateISO: '2026-10-19T22:04:00.000Z',
      body: 'Hello Dana,\nThe trail is closed.',
      attachmentNames: [],
    });
    expect(r.dedupeSource).toEqual({
      from: 'jane@example.org',
      dateISO: '2026-10-19T22:04:00.000Z',
      subject: 'Trail closure',
    });
  });

  it('forward: uses the block Message-ID for dedupe when present', async () => {
    const raw = forward.replace('Subject: Trail closure\n', 'Subject: Trail closure\nMessage-ID: <orig-1@example.org>\n');
    expect((await logged(raw)).dedupeSource).toEqual({ messageId: '<orig-1@example.org>' });
  });

  it("forward of staff's own sent message uses the block's To and Cc", async () => {
    const r = await logged(forwardOwn);
    expect(r.message.kind).toBe('forward');
    expect(r.message.counterparts).toEqual(['jane@example.org', 'bob@example.com']);
    expect(r.message.subject).toBe('Re: Grant question');
  });

  it('strips stacked Fwd: prefixes but keeps Re:', async () => {
    const raw = forward.replace('Subject: Fwd: Trail closure', 'Subject: Fwd: FW: Re: Trail closure');
    expect((await logged(raw)).message.subject).toBe('Re: Trail closure');
  });

  it('apple forward: same counterparts, subject, block date and body as a Gmail forward', async () => {
    const r = await logged(appleForward);
    expect(r.message).toEqual({
      kind: 'forward',
      counterparts: ['jane@example.org', 'bob@example.com'],
      subject: 'Trail closure',
      dateISO: '2026-11-02T21:58:55.000Z',
      body: 'Hello Dana,\nThe trail is closed.',
      attachmentNames: [],
    });
    expect(r.dedupeSource).toEqual({
      from: 'jane@example.org',
      dateISO: '2026-11-02T21:58:55.000Z',
      subject: 'Trail closure',
    });
  });

  it('apple forward: two forwards of one message share a dedupe hash', async () => {
    const second = appleForward
      .replace('From: Dana Staff <dana@bikesiliconvalley.org>', 'From: Sam Staff <sam@bikesiliconvalley.org>')
      .replace('Date: Mon, 2 Nov 2026 14:05:12 -0800', 'Date: Tue, 3 Nov 2026 09:30:00 -0800')
      .replace('<apple-fwd-1@bikesiliconvalley.org>', '<apple-fwd-2@bikesiliconvalley.org>')
      .replace('FYI, see below.', 'Logging this one too.');
    const [a, b] = await Promise.all([logged(appleForward), logged(second)]);
    expect(b.message.kind).toBe('forward');
    expect(await messageIdHash(b.dedupeSource)).toBe(await messageIdHash(a.dedupeSource));
  });

  it('apple forward: an html-only message falls back to bcc (its block is not line-broken)', async () => {
    const htmlOnlyApple = appleForward.replace(/--Apple-Mail=_A1B2C3\nContent-Transfer-Encoding: 7bit\nContent-Type: text\/plain;[\s\S]*?(?=--Apple-Mail=_A1B2C3\n)/, '');
    const r = await logged(htmlOnlyApple);
    expect(r.message.kind).toBe('bcc');
  });

  it('Fwd: subject with no parseable block falls back to bcc', async () => {
    const raw = bccNew.replace('Subject: Trail closure follow-up', 'Subject: Fwd: Trail closure follow-up');
    const r = await logged(raw);
    expect(r.message.kind).toBe('bcc');
    expect(r.message.subject).toBe('Fwd: Trail closure follow-up');
  });

  it('outlook forward falls back to bcc and is still logged', async () => {
    const r = await logged(outlook);
    expect(r.message.kind).toBe('bcc');
    expect(r.message.counterparts).toEqual([]);
    expect(r.message.subject).toBe('FW: Ride schedule');
  });

  it('Fwd: subject between staff only with no block is logged, not dropped', async () => {
    const raw = staffOnly.replace('Subject: Internal', 'Subject: Fwd: Internal');
    const r = await logged(raw);
    expect(r.message.kind).toBe('bcc');
    expect(r.message.counterparts).toEqual([]);
  });

  it('forward whose block is all staff is staff-only', async () => {
    const raw = forward.replace('From: Jane Rider <jane@example.org>', 'From: Jane <jane@bikesiliconvalley.org>').replace('Cc: Bob <bob@example.com>, ', 'Cc: ');
    expect(await run(raw)).toEqual({ kind: 'staff-only' });
  });

  it('bcc dedupe fallback uses the normalized subject', async () => {
    const raw = noMessageId.replace('Subject: No id', 'Subject:   ');
    expect((await logged(raw)).dedupeSource).toMatchObject({ subject: '(no subject)' });
  });

  it('lists attachment filenames and keeps no content', async () => {
    const r = await logged(withAttachment);
    expect(r.message.attachmentNames).toEqual(['flyer.pdf']);
    expect(JSON.stringify(r.message)).not.toContain('JVBERi');
  });

  it('ignores inline signature images', async () => {
    const r = await logged(withInlineImage);
    expect(r.message.attachmentNames).toEqual(['flyer.pdf']);
  });

  it('keeps an inline-disposition file that has no Content-ID (Apple Mail sends real files this way)', async () => {
    const r = await logged(withAttachment.replace('Content-Disposition: attachment;', 'Content-Disposition: inline;'));
    expect(r.message.attachmentNames).toEqual(['flyer.pdf']);
  });

  it('forward date falls back to the message Date when the block date is unparseable', async () => {
    const raw = forward.replace('Date: Mon, Oct 19, 2026 at 3:04 PM', 'Date: sometime last week');
    const r = await logged(raw);
    expect(r.message.dateISO).toBe('2026-10-20T21:00:00.000Z');
  });

  it('reads an html-only body', async () => {
    expect((await logged(htmlOnly)).message.body).toBe('Hello Jane');
  });

  it('bcc without Message-ID dedupes on from, date and subject', async () => {
    expect((await logged(noMessageId)).dedupeSource).toEqual({
      from: 'dana@bikesiliconvalley.org',
      dateISO: '2026-10-20T20:00:00.000Z',
      subject: 'No id',
    });
  });

  it('uses the injected now only when no Date header exists', async () => {
    const raw = noMessageId.replace(/^Date:.*\n/m, '');
    expect((await logged(raw)).message.dateISO).toBe(NOW.toISOString());
  });

  it('empty subject becomes (no subject)', async () => {
    const raw = bccNew.replace('Subject: Trail closure follow-up', 'Subject:   ');
    expect((await logged(raw)).message.subject).toBe('(no subject)');
  });
});
