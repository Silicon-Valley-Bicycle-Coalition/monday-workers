import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs operator script, no type declarations
import { createRedactor } from './redact.mjs';

const call = {
  event: 'phone.caller_call_element_completed',
  event_ts: 1763600000000,
  payload: {
    account_id: 'realAcct',
    object: {
      call_elements: [
        {
          call_id: '7301',
          user_id: 'u_real',
          direction: 'outbound',
          result: 'answered',
          start_time: '2026-11-19T18:00:00Z',
          talk_time: 725,
          caller_name: 'Real Staffer',
          caller_email: 'staffer@bikesiliconvalley.org',
          caller_ext_number: 204,
          caller_did_number: '+16505551234',
          callee_did_number: '+14089876543',
          mystery: 'something new',
        },
      ],
    },
  },
};

describe('createRedactor', () => {
  it('replaces people, numbers, emails and ids and keeps everything else', () => {
    const r = createRedactor();
    const el = r.redact(call).payload.object.call_elements[0];
    expect(el).toMatchObject({
      direction: 'outbound',
      result: 'answered',
      start_time: '2026-11-19T18:00:00Z',
      talk_time: 725,
      caller_name: 'Person 1',
      caller_email: 'person1@example.org',
      caller_ext_number: 101,
      caller_did_number: '+14085550101',
      callee_did_number: '+14085550102',
    });
    expect(el.call_id).toBe('call_id_1');
    expect(el.user_id).toBe('user_id_1');
    expect(r.redact(call).payload.account_id).toBe('account_id_1');
    expect(r.redact(call).event_ts).toBe(1763600000000);
  });

  it('maps the same value to the same stand-in across deliveries', () => {
    const r = createRedactor();
    r.redact(call);
    const sms = r.redact({
      event: 'phone.sms_received',
      payload: { object: { message: 'see you Sat', sender: { phone_number: '+14089876543' } } },
    });
    expect(sms.payload.object.sender.phone_number).toBe('+14085550102');
    expect(sms.payload.object.message).toBe('REDACTED MESSAGE TEXT');
  });

  it('lists strings no rule recognized', () => {
    const r = createRedactor();
    const out = r.redact(call);
    expect(out.payload.object.call_elements[0].mystery).toBe('something new');
    expect(r.needsReview()).toEqual(['$.payload.object.call_elements[0].mystery']);
  });

  it('catches a phone number or email under any key', () => {
    const r = createRedactor();
    const out = r.redact({ note: '+16505551234', who: 'a@b.org' });
    expect(out).toEqual({ note: '+14085550101', who: 'person1@example.org' });
  });
});
