import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('loads and validates the checked-in svbc config', () => {
    const cfg = loadConfig(); // defaults to config/svbc.json
    expect(cfg.salesforceOrg).toBe('svbc');
    expect(cfg.boardMaxItems).toBeLessThanOrEqual(9000);
    expect(cfg.donationsActiveFiscalYears).toBeGreaterThanOrEqual(1);
    expect(cfg.monday.boards['donations']).toBeDefined();
    expect(cfg.monday.apiUrl).toMatch(/^https:/);
    expect(cfg.localNews.defaultUrl).toContain('localnewsmatters');
  });

  it('throws a named error on missing required keys', () => {
    expect(() => loadConfig('config/nope.json')).toThrow(/config/i);
  });

  it('ships a consumer-mail domain list and an affiliations board key', () => {
    const cfg = loadConfig();
    expect(cfg.consumerEmailDomains).toContain('gmail.com');
    expect(cfg.consumerEmailDomains).toContain('comcast.net');
    expect('affiliations' in cfg.monday.boards).toBe(true);
  });
});
