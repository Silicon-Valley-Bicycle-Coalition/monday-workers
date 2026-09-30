import { describe, expect, it } from 'vitest';
import md5 from 'md5';
import { errorText, memberId, redactEmails } from './logSafe';

describe('memberId', () => {
  it("is Mailchimp's subscriber hash: MD5 of the trimmed, lowercased address", () => {
    expect(memberId('  Donor@Example.org ')).toBe(md5('donor@example.org'));
  });
});

describe('redactEmails', () => {
  it('replaces every address with its member id', () => {
    expect(redactEmails('mailchimp upsert: HTTP 400: {"detail":"Donor@Example.org is already a list member","other":"x@y.co"}')).toBe(
      `mailchimp upsert: HTTP 400: {"detail":"<member ${md5('donor@example.org')}> is already a list member","other":"<member ${md5('x@y.co')}>"}`,
    );
  });

  it('leaves text without an address alone', () => {
    expect(redactEmails('monday: HTTP 429 (retry in 30s) @ board 123')).toBe('monday: HTTP 429 (retry in 30s) @ board 123');
  });
});

describe('errorText', () => {
  it('redacts an Error message and a non-Error value alike', () => {
    expect(errorText(new Error('no Donor item matches a@b.com'))).toBe(`no Donor item matches <member ${md5('a@b.com')}>`);
    expect(errorText('bad a@b.com')).toBe(`bad <member ${md5('a@b.com')}>`);
  });
});
