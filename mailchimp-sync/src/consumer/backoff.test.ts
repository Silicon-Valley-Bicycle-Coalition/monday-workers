import { describe, it, expect } from 'vitest';
import { backoffSeconds, retryDelaySeconds, secondsUntilNextMidnightUtc, MAX_RETRY_DELAY_SECONDS } from './backoff';
import { MailchimpRateLimitError, MailchimpTransientError } from '../mailchimp/client';
import { MondayApiError } from '../monday/client';

const NOW = new Date('2026-09-25T18:00:00Z');

describe('backoffSeconds', () => {
  it('is 1, 4, 16 minutes across the three attempts max_retries allows', () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(240);
    expect(backoffSeconds(3)).toBe(960);
  });

  it('caps at Queues\' 12-hour maximum delay', () => {
    expect(backoffSeconds(10)).toBe(MAX_RETRY_DELAY_SECONDS);
    expect(MAX_RETRY_DELAY_SECONDS).toBe(43200);
  });

  it('treats a missing or nonsensical attempt count as the first attempt', () => {
    expect(backoffSeconds(undefined)).toBe(60);
    expect(backoffSeconds(0)).toBe(60);
    expect(backoffSeconds(Number.NaN)).toBe(60);
  });
});

describe('secondsUntilNextMidnightUtc', () => {
  it('counts to the next 00:00 UTC', () => {
    expect(secondsUntilNextMidnightUtc(NOW)).toBe(6 * 3600);
    expect(secondsUntilNextMidnightUtc(new Date('2026-12-31T23:59:59.500Z'))).toBe(1);
  });
});

describe('retryDelaySeconds', () => {
  it('uses plain backoff for errors with no rate-limit hint', () => {
    expect(retryDelaySeconds(2, new Error('boom'), NOW)).toBe(240);
    expect(retryDelaySeconds(1, new MailchimpTransientError('503'), NOW)).toBe(60);
    expect(retryDelaySeconds(1, new MailchimpRateLimitError('429', undefined), NOW)).toBe(60);
    expect(retryDelaySeconds(3, new MondayApiError('x', { httpStatus: 500 }), NOW)).toBe(960);
  });

  it('waits at least a Mailchimp Retry-After hint', () => {
    expect(retryDelaySeconds(1, new MailchimpRateLimitError('429', 300), NOW)).toBe(300);
    // A hint shorter than the backoff never shortens it.
    expect(retryDelaySeconds(2, new MailchimpRateLimitError('429', 5), NOW)).toBe(240);
  });

  it('waits at least Monday\'s retry_in_seconds, rounding fractional hints up', () => {
    expect(retryDelaySeconds(1, new MondayApiError('x', { httpStatus: 429, code: 'COMPLEXITY_BUDGET_EXHAUSTED', retryAfterSeconds: 90.2 }), NOW)).toBe(91);
    expect(retryDelaySeconds(3, new MondayApiError('x', { httpStatus: 429, code: 'RATE_LIMIT_EXCEEDED', retryAfterSeconds: 30 }), NOW)).toBe(960);
  });

  it('delays a hintless DAILY_LIMIT_EXCEEDED until midnight UTC', () => {
    expect(retryDelaySeconds(1, new MondayApiError('x', { httpStatus: 429, code: 'DAILY_LIMIT_EXCEEDED' }), NOW)).toBe(6 * 3600);
  });

  it('prefers an explicit hint over the midnight default for DAILY_LIMIT_EXCEEDED', () => {
    expect(retryDelaySeconds(1, new MondayApiError('x', { httpStatus: 429, code: 'DAILY_LIMIT_EXCEEDED', retryAfterSeconds: 600 }), NOW)).toBe(600);
  });

  it('caps any hint at 12 hours', () => {
    expect(retryDelaySeconds(1, new MailchimpRateLimitError('429', 999_999), NOW)).toBe(MAX_RETRY_DELAY_SECONDS);
    const justAfterMidnight = new Date('2026-09-25T00:00:01Z');
    expect(retryDelaySeconds(1, new MondayApiError('x', { httpStatus: 429, code: 'DAILY_LIMIT_EXCEEDED' }), justAfterMidnight)).toBe(MAX_RETRY_DELAY_SECONDS);
  });
});
