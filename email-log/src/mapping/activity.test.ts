import { describe, it, expect } from 'vitest';
import { buildActivity } from './activity';
import type { LogQueueMessage } from '../inbound/extract';
import { testConfig } from '../test/testConfig';

const config = testConfig();

function message(overrides: Partial<LogQueueMessage> = {}): LogQueueMessage {
  return {
    messageIdHash: 'abc123',
    kind: 'bcc',
    staffEmail: 'dana@example.org',
    counterparts: ['pat@gmail.com'],
    subject: 'Ride planning',
    dateISO: '2026-10-19T17:05:09.000Z',
    body: 'Hello Pat',
    attachmentNames: [],
    ...overrides,
  };
}

describe('buildActivity', () => {
  it('sets type, date, Done, owner, person, notes, hash', () => {
    const { name, columnValues } = buildActivity(message(), { personItemIds: ['11', '22'], unmatched: [] }, 77, config);
    expect(name).toBe('Ride planning');
    expect(columnValues).toEqual({
      type_col: { label: 'Email' },
      date_col: { date: '2026-10-19', time: '17:05:09' },
      status_col: { label: 'Done' },
      owner_col: { personsAndTeams: [{ id: 77, kind: 'person' }] },
      person_col: { item_ids: [11, 22] },
      notes_col: { text: 'Hello Pat\n\nSent by dana@example.org to pat@gmail.com' },
      hash_col: 'abc123',
    });
  });

  it('no match → Needs Person and no person column', () => {
    const { columnValues } = buildActivity(message(), { personItemIds: [], unmatched: [] }, 77, config);
    expect(columnValues.status_col).toEqual({ label: 'Needs Person' });
    expect(columnValues).not.toHaveProperty('person_col');
  });

  it('no owner → owner column omitted and "Logged by <staffEmail>" in the footer', () => {
    const { columnValues } = buildActivity(message(), { personItemIds: ['11'], unmatched: [] }, null, config);
    expect(columnValues).not.toHaveProperty('owner_col');
    expect(columnValues.notes_col).toEqual({
      text: 'Hello Pat\n\nSent by dana@example.org to pat@gmail.com\nLogged by dana@example.org',
    });
  });

  describe('notes footer', () => {
    it('bcc with unmatched addresses and attachments', () => {
      const { columnValues } = buildActivity(
        message({ counterparts: ['a@x.com', 'b@y.com'], attachmentNames: ['plan.pdf', 'map.png'] }),
        { personItemIds: ['11'], unmatched: ['b@y.com'] },
        77,
        config,
      );
      expect(columnValues.notes_col).toEqual({
        text: [
          'Hello Pat',
          '',
          'Sent by dana@example.org to a@x.com, b@y.com',
          "Not on anyone's record: b@y.com",
          'Attachments (not saved): plan.pdf, map.png',
        ].join('\n'),
      });
    });

    it('bcc with no counterparts', () => {
      const { columnValues } = buildActivity(message({ counterparts: [] }), { personItemIds: [], unmatched: [] }, 77, config);
      expect(columnValues.notes_col).toEqual({ text: 'Hello Pat\n\nSent by dana@example.org' });
    });

    it('forward', () => {
      const { columnValues } = buildActivity(
        message({ kind: 'forward', counterparts: ['pat@gmail.com', 'lee@gmail.com'] }),
        { personItemIds: ['11'], unmatched: [] },
        77,
        config,
      );
      expect(columnValues.notes_col).toEqual({
        text: 'Hello Pat\n\nReceived from pat@gmail.com, lee@gmail.com, forwarded by dana@example.org',
      });
    });

    it('empty body leaves just the footer', () => {
      const { columnValues } = buildActivity(message({ body: '' }), { personItemIds: [], unmatched: [] }, 77, config);
      expect(columnValues.notes_col).toEqual({ text: 'Sent by dana@example.org to pat@gmail.com' });
    });
  });

  it('caps notes at 2000 characters and keeps the footer', () => {
    const footer = 'Sent by dana@example.org to pat@gmail.com';
    const { columnValues } = buildActivity(message({ body: 'x'.repeat(5000) }), { personItemIds: [], unmatched: [] }, 77, config);
    const text = (columnValues.notes_col as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.endsWith(`\n\n${footer}`)).toBe(true);
    expect(text).toContain('… [truncated]');
  });

  it('cuts the item name to 255 characters', () => {
    const { name } = buildActivity(message({ subject: 'a'.repeat(300) }), { personItemIds: [], unmatched: [] }, 77, config);
    expect(name.length).toBe(255);
    const emoji = buildActivity(message({ subject: 'a'.repeat(240) + '😀'.repeat(20) }), { personItemIds: [], unmatched: [] }, 77, config).name;
    expect(emoji.length).toBeLessThanOrEqual(255);
    expect(emoji).not.toMatch(/[\ud800-\udbff]… /);
  });
});
