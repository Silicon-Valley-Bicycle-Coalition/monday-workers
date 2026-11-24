import { describe, it, expect } from 'vitest';
import { classifySendError, sendErrorCode } from './sendErrors';

const coded = (code: unknown) => Object.assign(new Error('x'), { code });

describe('classifySendError', () => {
  it.each(['E_VALIDATION_ERROR', 'E_RECIPIENT_SUPPRESSED', 'E_DELIVERY_FAILED'])('%s is rejected', (c) => expect(classifySendError(coded(c))).toBe('rejected'));
  it.each(['E_DAILY_LIMIT_EXCEEDED', 'E_SENDER_DOMAIN_NOT_AVAILABLE'])('%s stops', (c) => expect(classifySendError(coded(c))).toBe('stop'));
  it('a malformed message is rejected', () => expect(classifySendError(new TypeError('bad argument'))).toBe('rejected'));
  it.each([coded('E_INTERNAL_SERVER_ERROR'), coded('E_SOMETHING_NEW'), coded(42), new Error('network'), null, 'text'])('anything else may have been sent', (e) => {
    expect(classifySendError(e)).toBe('unknown');
  });
  it('never returns a code that could carry other text', () => {
    expect(sendErrorCode(coded('E_OOPS pat@example.org'))).toBeNull();
    expect(sendErrorCode(coded('E_OK_CODE'))).toBe('E_OK_CODE');
  });
});
