import { describe, it, expect } from 'vitest';
import md5 from 'md5';
import { planRedrive, redactEmails, redriveUrl, selectDeadLetteredSql, parseDirections, parseBound, DEAD_LETTER_PREFIX as LIB_PREFIX } from './redrive-dead-lettered-lib.mjs';
import { DEAD_LETTER_PREFIX as WORKER_PREFIX } from '../src/consumer/deadLetters';
import { validateMondayWebhookBody } from '../src/webhook/validateMonday';
import { validateMailchimpWebhookBody } from '../src/webhook/validateMailchimp';

const row = (over = {}) => ({
  key: '111',
  error: 'dead-lettered after retries: mailchimp updateMember: HTTP 500',
  received_at: '2026-09-20T00:00:00.000Z',
  ...over,
});

describe('DEAD_LETTER_PREFIX', () => {
  it('matches the mark the Worker writes', () => {
    expect(LIB_PREFIX).toBe(WORKER_PREFIX);
  });
});

describe('selectDeadLetteredSql', () => {
  it('selects only failed rows carrying the dead-letter mark, from the right table', () => {
    const out = selectDeadLetteredSql('outbound', {});
    expect(out).toContain('FROM pending_outbound_syncs');
    expect(out).toContain('donor_item_id AS key');
    expect(out).toContain(`status = 'failed'`);
    expect(out).toContain(`error LIKE 'dead-lettered after retries: %'`);
    const inbound = selectDeadLetteredSql('inbound', {});
    expect(inbound).toContain('FROM pending_inbound_syncs');
    expect(inbound).toContain('email AS key');
  });

  it('bounds received_at by --since / --until', () => {
    const out = selectDeadLetteredSql('outbound', { since: '2026-09-01T00:00:00.000Z', until: '2026-09-25T00:00:00.000Z' });
    expect(out).toContain(`received_at >= '2026-09-01T00:00:00.000Z'`);
    expect(out).toContain(`received_at < '2026-09-25T00:00:00.000Z'`);
  });

  it('refuses an unknown direction or a non-ISO bound (the SQL goes to wrangler --command)', () => {
    expect(() => selectDeadLetteredSql('sideways', {})).toThrow();
    expect(() => selectDeadLetteredSql('outbound', { since: "x' OR 1=1 --" })).toThrow();
  });
});

describe('parseBound', () => {
  it('accepts a date or an ISO UTC timestamp and normalizes to a timestamp', () => {
    expect(parseBound('2026-09-01')).toBe('2026-09-01T00:00:00.000Z');
    expect(parseBound('2026-09-01T12:30:00Z')).toBe('2026-09-01T12:30:00.000Z');
    expect(parseBound(undefined)).toBeUndefined();
  });

  it('refuses anything else', () => {
    expect(() => parseBound('last tuesday')).toThrow();
    expect(() => parseBound("2026-09-01' OR 1=1")).toThrow();
  });
});

describe('parseDirections', () => {
  it('defaults to both and validates', () => {
    expect(parseDirections(undefined)).toEqual(['outbound', 'inbound']);
    expect(parseDirections('both')).toEqual(['outbound', 'inbound']);
    expect(parseDirections('inbound')).toEqual(['inbound']);
    expect(() => parseDirections('up')).toThrow();
  });
});

describe('planRedrive', () => {
  it('rebuilds an outbound delivery the Monday route accepts for the same Donor item', () => {
    const [d] = planRedrive('outbound', [row()]);
    expect(d.id).toBe('111');
    expect(d.path).toBe('/webhooks/monday/donors');
    expect(d.contentType).toBe('application/json');
    const event = validateMondayWebhookBody(JSON.parse(d.body));
    expect(event.donorItemId).toBe('111');
    // No columnId: the route's self-inflicted-event skip must not swallow a replay.
    expect(event.columnId).toBeUndefined();
  });

  it('rebuilds an inbound delivery the Mailchimp route accepts, and names it by member id, not address', () => {
    const [d] = planRedrive('inbound', [row({ key: 'donor@example.com' })]);
    expect(d.id).toBe(md5('donor@example.com'));
    expect(d.path).toBe('/webhooks/mailchimp/audience');
    expect(d.contentType).toBe('application/x-www-form-urlencoded');
    expect(validateMailchimpWebhookBody(new URLSearchParams(d.body)).email).toBe('donor@example.com');
    expect(JSON.stringify({ id: d.id, error: d.error })).not.toContain('donor@example.com');
  });

  it('filters to the given item / member ids', () => {
    const out = planRedrive('outbound', [row({ key: '1' }), row({ key: '2' }), row({ key: '3' })], { ids: ['3', '1'] });
    expect(out.map((d) => d.id)).toEqual(['1', '3']);
    const inbound = planRedrive('inbound', [row({ key: 'a@example.com' }), row({ key: 'b@example.com' })], { ids: [md5('b@example.com')] });
    expect(inbound.map((d) => d.id)).toEqual([md5('b@example.com')]);
  });

  it('orders by received_at then id, so a resumed run sees the same plan', () => {
    const out = planRedrive('outbound', [
      row({ key: 'b', received_at: '2026-09-21T00:00:00.000Z' }),
      row({ key: 'c', received_at: '2026-09-20T00:00:00.000Z' }),
      row({ key: 'a', received_at: '2026-09-21T00:00:00.000Z' }),
    ]);
    expect(out.map((d) => d.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('redactEmails', () => {
  it('masks email-like text an upstream error body may have echoed', () => {
    expect(redactEmails('mailchimp: HTTP 503: Donor.Name+x@Example.org is busy')).toBe('mailchimp: HTTP 503: <email> is busy');
    expect(redactEmails(null)).toBeNull();
  });
});

describe('redriveUrl', () => {
  it('puts the shared secret where the route checks it — the query string, as Monday and Mailchimp send it', () => {
    expect(redriveUrl('https://w.example/', '/webhooks/monday/donors', 's e/cret')).toBe('https://w.example/webhooks/monday/donors?secret=s%20e%2Fcret');
  });
});
