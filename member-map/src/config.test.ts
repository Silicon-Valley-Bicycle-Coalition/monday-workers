import { describe, it, expect } from 'vitest';
import sandbox from '../config/sandbox.json';
import { validateConfig } from './config';

describe('validateConfig', () => {
  it('accepts the sandbox config', () => expect(validateConfig(sandbox).boards.peopleLive).toBe(18431577220));

  it('rejects a missing column title', () => {
    const bad = structuredClone(sandbox);
    delete (bad.columns as Record<string, unknown>).lat;
    expect(() => validateConfig(bad)).toThrow(/columns\.lat/);
  });

  it('rejects a non-https teamDomain when set', () => {
    const bad = structuredClone(sandbox);
    bad.access.teamDomain = 'http://x.cloudflareaccess.com';
    expect(() => validateConfig(bad)).toThrow(/teamDomain/);
  });

  it('allows an empty teamDomain (Access not set up yet)', () => {
    const ok = structuredClone(sandbox);
    ok.access.teamDomain = '';
    expect(validateConfig(ok).access.teamDomain).toBe('');
  });

  it('rejects allowedEmailDomain with an @', () => {
    const bad = structuredClone(sandbox);
    bad.access.allowedEmailDomain = '@bikesiliconvalley.org';
    expect(() => validateConfig(bad)).toThrow(/allowedEmailDomain/);
  });

  it('allows a 0 placeholder board id but rejects a negative one', () => {
    const ok = structuredClone(sandbox);
    ok.boards.organizations = 0;
    expect(validateConfig(ok).boards.organizations).toBe(0);
    const bad = structuredClone(sandbox);
    bad.boards.organizations = -1;
    expect(() => validateConfig(bad)).toThrow(/boards\.organizations/);
  });
});
