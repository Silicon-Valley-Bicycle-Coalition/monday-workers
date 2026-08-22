import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('loads and validates the checked-in svbc config', () => {
    const cfg = loadConfig(); // defaults to config/svbc.json
    expect(cfg.salesforceOrg).toBe('svbc');
    expect(cfg.eraMaxItems).toBeLessThanOrEqual(9000);
    expect(cfg.monday.apiUrl).toMatch(/^https:/);
    expect(cfg.localNews.defaultUrl).toContain('localnewsmatters');
  });

  it('throws a named error on missing required keys', () => {
    expect(() => loadConfig('config/nope.json')).toThrow(/config/i);
  });
});
