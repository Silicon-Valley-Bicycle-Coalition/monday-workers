import { describe, it, expect } from 'vitest';
import { emailDomain, websiteDomain, classifyDomain, DEFAULT_CONSUMER_DOMAINS } from './emailKind.js';

describe('emailDomain', () => {
  it('lowercases and takes the part after @', () => {
    expect(emailDomain('Ada@Example.ORG')).toBe('example.org');
    expect(emailDomain(' ada@example.org ')).toBe('example.org');
  });
  it('is null for blank or malformed input', () => {
    expect(emailDomain(null)).toBeNull();
    expect(emailDomain('')).toBeNull();
    expect(emailDomain('no-at-sign')).toBeNull();
    expect(emailDomain('trailing@')).toBeNull();
  });
});

describe('websiteDomain', () => {
  it('strips scheme, www, path, and port', () => {
    expect(websiteDomain('https://www.Acme.example/about')).toBe('acme.example');
    expect(websiteDomain('acme.example')).toBe('acme.example');
    expect(websiteDomain('http://acme.example:8080/')).toBe('acme.example');
  });
  it('is null for blank input', () => {
    expect(websiteDomain(null)).toBeNull();
    expect(websiteDomain('   ')).toBeNull();
  });
});

describe('classifyDomain', () => {
  const orgDomains = new Map([['org-acme', 'acme.example'], ['org-city', 'sanjoseca.gov']]);
  const consumer = new Set(DEFAULT_CONSUMER_DOMAINS);
  it('is work when the domain matches one of the candidate orgs', () => {
    expect(classifyDomain('acme.example', ['org-acme', 'org-city'], orgDomains, consumer))
      .toEqual({ kind: 'work', orgSfId: 'org-acme' });
  });
  it('matches subdomains of an org domain', () => {
    expect(classifyDomain('mail.sanjoseca.gov', ['org-city'], orgDomains, consumer))
      .toEqual({ kind: 'work', orgSfId: 'org-city' });
  });
  it('ignores org domains the person is not affiliated with', () => {
    expect(classifyDomain('acme.example', ['org-city'], orgDomains, consumer)).toEqual({ kind: 'unknown' });
  });
  it('is consumer for a known mailbox provider', () => {
    expect(classifyDomain('gmail.com', ['org-acme'], orgDomains, consumer)).toEqual({ kind: 'consumer' });
  });
  it('is unknown for anything else, including null', () => {
    expect(classifyDomain('startup.io', ['org-acme'], orgDomains, consumer)).toEqual({ kind: 'unknown' });
    expect(classifyDomain(null, ['org-acme'], orgDomains, consumer)).toEqual({ kind: 'unknown' });
  });
  it('prefers a work match over a consumer match if an org somehow uses a consumer domain', () => {
    const odd = new Map([['org-club', 'gmail.com']]);
    expect(classifyDomain('gmail.com', ['org-club'], odd, consumer)).toEqual({ kind: 'work', orgSfId: 'org-club' });
  });
});
