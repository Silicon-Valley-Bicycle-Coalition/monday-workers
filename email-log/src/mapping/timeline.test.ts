import { describe, it, expect } from 'vitest';
import { buildTimelineEntry } from './timeline';
import type { LogQueueMessage } from '../inbound/extract';

function message(overrides: Partial<LogQueueMessage> = {}): LogQueueMessage {
  return {
    messageIdHash: 'abc123',
    kind: 'bcc',
    staffEmail: 'dana@example.org',
    counterparts: ['pat@gmail.com'],
    subject: 'Ride planning',
    dateISO: '2026-10-19T10:05:09-07:00',
    body: 'Hello Pat',
    attachmentNames: [],
    ...overrides,
  };
}

const URL = 'https://example.monday.com/boards/111/pulses/1000';

describe('buildTimelineEntry', () => {
  it('uses the subject, the email date in UTC, the Activity item link and the custom activity', () => {
    const entry = buildTimelineEntry(message(), 'Hello Pat\n\nSent by dana@example.org to pat@gmail.com', URL, 'act-1');
    expect(entry).toEqual({
      customActivityId: 'act-1',
      title: 'Ride planning',
      summary: 'Hello Pat',
      content: 'Hello Pat<br><br>Sent by dana@example.org to pat@gmail.com',
      timestamp: '2026-10-19T17:05:09.000Z',
      url: URL,
    });
  });

  it('escapes HTML in the notes before turning newlines into <br>', () => {
    const entry = buildTimelineEntry(message(), '<b>hi</b> & "bye"\nnext', URL, 'act-1');
    expect(entry.content).toBe('&lt;b&gt;hi&lt;/b&gt; &amp; &quot;bye&quot;<br>next');
  });

  it('summarizes the body on one line, held to 255 characters', () => {
    const entry = buildTimelineEntry(message({ body: `Line one\n\n  line two ${'x'.repeat(400)}` }), 'notes', URL, 'act-1');
    expect(entry.summary.startsWith('Line one line two x')).toBe(true);
    expect(entry.summary.length).toBeLessThanOrEqual(255);
  });

  it('falls back to the notes for the summary when the body is empty', () => {
    const entry = buildTimelineEntry(message({ body: '' }), 'Sent by dana@example.org to pat@gmail.com', URL, 'act-1');
    expect(entry.summary).toBe('Sent by dana@example.org to pat@gmail.com');
  });

  it('holds the title to 255 characters', () => {
    const entry = buildTimelineEntry(message({ subject: 's'.repeat(300) }), 'notes', URL, 'act-1');
    expect(entry.title.length).toBe(255);
  });
});
