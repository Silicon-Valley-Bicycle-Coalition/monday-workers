import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    // The "Anonymous Person" Contact + its household Account (741 Opportunities point at them).
    expect(cfg.placeholderDonorSfIds).toEqual(['003i000001breKtAAI', '001i000001Esfc1AAB']);
    // The user the eb4sf Eventbrite package writes paid ticket orders as (#43).
    expect(cfg.eventbriteIntegrationUserName).toBe('SVBC Integration');
  });

  it('throws a named error on missing required keys', () => {
    expect(() => loadConfig('config/nope.json')).toThrow(/config/i);
  });

  it('rejects a blank or non-string eventbriteIntegrationUserName, and accepts its absence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'si-config-'));
    const base = JSON.parse(readFileSync('config/svbc.json', 'utf8')) as Record<string, unknown>;
    const write = (name: string, value: unknown) => {
      const path = join(dir, `${name}.json`);
      const cfg = { ...base };
      if (value === undefined) delete cfg['eventbriteIntegrationUserName']; else cfg['eventbriteIntegrationUserName'] = value;
      writeFileSync(path, JSON.stringify(cfg));
      return path;
    };
    try {
      expect(() => loadConfig(write('blank', '  '))).toThrow(/eventbriteIntegrationUserName/);
      expect(() => loadConfig(write('number', 7))).toThrow(/eventbriteIntegrationUserName/);
      expect(loadConfig(write('absent', undefined)).eventbriteIntegrationUserName).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a null or non-positive monday.workspaceId placeholder, and accepts its absence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'si-config-ws-'));
    const base = JSON.parse(readFileSync('config/svbc.json', 'utf8')) as { monday: Record<string, unknown> };
    const write = (name: string, value: unknown) => {
      const path = join(dir, `${name}.json`);
      const monday = { ...base.monday };
      if (value === undefined) delete monday['workspaceId']; else monday['workspaceId'] = value;
      writeFileSync(path, JSON.stringify({ ...base, monday }));
      return path;
    };
    try {
      // The prepared production config (runbook 0.5) carries null until the workspace exists (0.3).
      expect(() => loadConfig(write('null', null))).toThrow(/workspaceId.*runbook step 0\.3/);
      expect(() => loadConfig(write('zero', 0))).toThrow(/workspaceId/);
      expect(() => loadConfig(write('string', '17141226'))).toThrow(/workspaceId/);
      expect(loadConfig(write('absent', undefined)).monday.workspaceId).toBeUndefined();
      expect(loadConfig(write('set', 17141226)).monday.workspaceId).toBe(17141226);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ships a consumer-mail domain list and an affiliations board key', () => {
    const cfg = loadConfig();
    expect(cfg.consumerEmailDomains).toContain('gmail.com');
    expect(cfg.consumerEmailDomains).toContain('comcast.net');
    expect('affiliations' in cfg.monday.boards).toBe(true);
  });
});
