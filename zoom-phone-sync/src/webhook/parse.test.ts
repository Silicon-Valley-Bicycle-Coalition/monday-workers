import { describe, it, expect } from 'vitest';
import callerFixture from '../../test/fixtures/caller_call_element_completed.json';
import calleeFixture from '../../test/fixtures/callee_call_element_completed.json';
import smsSentFixture from '../../test/fixtures/sms_sent.json';
import smsReceivedFixture from '../../test/fixtures/sms_received.json';
import { parseDelivery, toE164 } from './parse';
import { testConfig } from '../test/testConfig';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('toE164', () => {
  it.each([
    ['+14085550123', '+14085550123'],
    ['+1 (408) 555-0123', '+14085550123'],
    ['(408) 555-0123', '+14085550123'],
    ['14085550123', '+14085550123'],
    ['+442071838750', '+442071838750'],
  ])('%s → %s', (input, expected) => expect(toE164(input, 'US')).toBe(expected));

  it.each(['', 'anonymous', '101', '+0123456789', '5550123', null, undefined])('%s → null', (input) => {
    expect(toE164(input, 'US')).toBeNull();
  });
});

describe('parseDelivery: calls', () => {
  it('reads an outbound call from the caller event', () => {
    const { events, skipped } = parseDelivery('phone.caller_call_element_completed', callerFixture.payload, testConfig());
    expect(skipped).toEqual({ internal: 0, excluded: 0, noExternalNumber: 0, malformed: 0 });
    expect(events).toEqual([
      {
        eventId: 'ce_out_1',
        kind: 'call',
        callId: 'call_out_1',
        occurredAt: '2026-11-19T18:00:00.000Z',
        zoomUserId: 'user_ann',
        externalE164: '+14085550123',
        direction: 'outbound',
        result: 'answered',
        talkSeconds: 725,
      },
    ]);
  });

  it('reads an inbound call from the callee event, the caller being external', () => {
    const { events } = parseDelivery('phone.callee_call_element_completed', calleeFixture.payload, testConfig());
    expect(events[0]).toMatchObject({ eventId: 'ce_in_1', direction: 'inbound', externalE164: '+14085550123', result: 'voicemail', talkSeconds: 0 });
  });

  it('accepts nested caller/callee objects and a single element without call_elements', () => {
    const payload = {
      object: {
        call_element_id: 'ce_nested',
        start_time: '2026-11-19T18:00:00Z',
        connect_type: 'external',
        caller: { id: 'user_ann', did_number: '+14085550100' },
        callee: { did_number: '+14085550123' },
      },
    };
    const { events } = parseDelivery('phone.caller_call_element_completed', payload, testConfig());
    expect(events[0]).toMatchObject({ eventId: 'ce_nested', zoomUserId: 'user_ann', externalE164: '+14085550123', direction: 'outbound' });
  });

  it('drops internal calls', () => {
    const payload = clone(callerFixture.payload);
    payload.object.call_elements[0]!.connect_type = 'internal';
    expect(parseDelivery('phone.caller_call_element_completed', payload, testConfig()).skipped.internal).toBe(1);
  });

  it('drops a call with no external number (blocked or anonymous)', () => {
    const payload = clone(callerFixture.payload) as { object: { call_elements: Record<string, unknown>[] } };
    payload.object.call_elements[0]!.callee_did_number = 'anonymous';
    const result = parseDelivery('phone.caller_call_element_completed', payload, testConfig());
    expect(result.events).toEqual([]);
    expect(result.skipped.noExternalNumber).toBe(1);
  });

  it('counts an element without an id or start time as malformed', () => {
    const payload = clone(callerFixture.payload) as { object: { call_elements: Record<string, unknown>[] } };
    delete payload.object.call_elements[0]!.call_element_id;
    expect(parseDelivery('phone.caller_call_element_completed', payload, testConfig()).skipped.malformed).toBe(1);
    expect(parseDelivery('phone.caller_call_element_completed', {}, testConfig()).skipped.malformed).toBe(1);
  });

  it('keeps no recording or voicemail id', () => {
    const { events } = parseDelivery('phone.callee_call_element_completed', calleeFixture.payload, testConfig());
    expect(JSON.stringify(events)).not.toMatch(/rec_|vm_/);
  });
});

describe('parseDelivery: staff line filter', () => {
  it('excludeUsers matches a user id, email or extension, case-insensitively', () => {
    for (const entry of ['user_ann', 'ANN@example.org', '101']) {
      const { skipped } = parseDelivery('phone.caller_call_element_completed', callerFixture.payload, testConfig({ excludeUsers: [entry] }));
      expect(skipped.excluded, entry).toBe(1);
    }
  });

  it('includeUsers keeps only the listed lines; [] keeps none', () => {
    expect(parseDelivery('phone.sms_sent', smsSentFixture.payload, testConfig({ includeUsers: ['user_ann'] })).events).toHaveLength(1);
    expect(parseDelivery('phone.sms_sent', smsSentFixture.payload, testConfig({ includeUsers: ['user_bob'] })).skipped.excluded).toBe(1);
    expect(parseDelivery('phone.sms_sent', smsSentFixture.payload, testConfig({ includeUsers: [] })).skipped.excluded).toBe(1);
  });
});

describe('parseDelivery: texts', () => {
  it('reads a sent text, external number from to_members', () => {
    const { events } = parseDelivery('phone.sms_sent', smsSentFixture.payload, testConfig());
    expect(events).toEqual([
      {
        eventId: 'msg_out_1',
        kind: 'text',
        callId: null,
        occurredAt: '2026-11-19T20:00:00.000Z',
        zoomUserId: 'user_ann',
        externalE164: '+14085550123',
        direction: 'outbound',
        result: null,
        talkSeconds: null,
      },
    ]);
  });

  it('reads a received text, external number from the sender', () => {
    const { events } = parseDelivery('phone.sms_received', smsReceivedFixture.payload, testConfig());
    expect(events[0]).toMatchObject({ eventId: 'msg_in_1', direction: 'inbound', externalE164: '+14085550123', zoomUserId: 'user_ann' });
  });

  it('never carries the message text', () => {
    for (const [name, fixture] of [['phone.sms_sent', smsSentFixture], ['phone.sms_received', smsReceivedFixture]] as const) {
      const result = parseDelivery(name, fixture.payload, testConfig());
      expect(JSON.stringify(result)).not.toContain('SECRET-TEXT');
    }
  });
});
