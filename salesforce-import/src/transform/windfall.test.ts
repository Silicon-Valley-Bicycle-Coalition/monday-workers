import { describe, it, expect } from 'vitest';
import { windfallColumns, windfallProfile, WINDFALL_FIELDS } from './windfall.js';
import { contactToPayload } from './people.js';
import { buildExtracts } from '../extract/queries.js';
import { loadConfig } from '../config.js';
import { COLUMN_TYPES, CURRENCY_COLUMNS } from '../load/boards.js';
import { BOARD_SPECS } from '../configure/spec.js';

// Shaped like a real 2026-10-26 Contact (values changed).
const screened = {
  Id: 'c1', wf_windfall_id__c: 'wf-123', Windfall_Priority__c: 51,
  wf_net_worth__c: 12000000, wf_low_confidence_net_worth__c: 9800000, wf_high_confidence_net_worth__c: 14500000,
  wf_net_worth_calculation_date__c: '2025-07-22', wf_philanthropic_giver__c: true,
  wf_job_title__c: ' Chief Engineer ', wf_company_name__c: 'Acme Corp', wf_linkedin_url__c: 'linkedin.com/in/someone',
  wf_job_title_level__c: 'C-Suite', wf_company_employees_range__c: '11-50', wf_company_phone__c: '4085550100',
  wf_company_address_line_one__c: '1 Main St', wf_company_city__c: 'San Jose', wf_company_state_code__c: 'CA',
  wf_ntee_codes__c: 'A,C', wf_regional_focus__c: 'LOCAL', wf_match_confidence__c: 0.7,
  wf_trust__c: true, wf_boat_owner__c: true, wf_recent_mover__c: false,
  wf_political_party__c: 'Democrat', wf_political_donor__c: true, wf_top_political_donor__c: true,
};

describe('windfallColumns', () => {
  it('writes the nine real columns and the snapshot priority', () => {
    const cols = windfallColumns(screened);
    expect(cols).toMatchObject({
      'Windfall ID': 'wf-123', 'Windfall Priority': '51',
      'Net Worth': '12000000', 'Net Worth Low': '9800000', 'Net Worth High': '14500000',
      'Net Worth Date': { date: '2025-07-22' }, 'Philanthropic Giver': { checked: 'true' },
      'Job Title': 'Chief Engineer', 'Windfall Company': 'Acme Corp', 'LinkedIn': 'linkedin.com/in/someone',
    });
  });

  it('writes nothing for a Contact Windfall never matched, even though the priority formula is never blank', () => {
    expect(windfallColumns({ Id: 'c2', Windfall_Priority__c: 1, wf_net_worth__c: null })).toEqual({});
  });

  it('omits empty fields rather than writing blanks', () => {
    const cols = windfallColumns({ Id: 'c3', wf_windfall_id__c: 'wf-9', wf_philanthropic_giver__c: false,
      wf_net_worth__c: null, wf_job_title__c: '' });
    expect(cols).toEqual({ 'Windfall ID': 'wf-9' });
  });

  it('never carries political data, in a column or the profile', () => {
    const all = JSON.stringify(windfallColumns(screened));
    expect(all).not.toMatch(/Democrat|Political|political/);
    for (const f of WINDFALL_FIELDS) expect(f).not.toMatch(/political|wf_last_updated/);
  });

  it('every column it writes has a load type, and the money ones are currency', () => {
    for (const title of Object.keys(windfallColumns(screened))) expect(COLUMN_TYPES[title], title).toBeDefined();
    for (const title of ['Net Worth', 'Net Worth Low', 'Net Worth High']) expect(CURRENCY_COLUMNS.has(title)).toBe(true);
    expect(CURRENCY_COLUMNS.has('Windfall Priority')).toBe(false);
  });

  it('describes every column on both People boards', () => {
    for (const board of ['people-live', 'people-historical']) {
      const desc = BOARD_SPECS[board]!.columnDescriptions!;
      for (const title of Object.keys(windfallColumns(screened))) expect(desc[title], `${board} / ${title}`).toBeTruthy();
    }
  });
});

describe('windfallProfile', () => {
  it('lists the remaining text fields, the company address, and the true flags', () => {
    expect(windfallProfile(screened)).toBe([
      'Job Level: C-Suite',
      'Company Size: 11-50',
      'Company Phone: 4085550100',
      'Company Address: 1 Main St, San Jose, CA',
      'Net Worth Match Confidence: 0.7',
      'NTEE Codes: A,C',
      'Regional Focus: LOCAL',
      'Flags: Trust Association, Boat Owner',
    ].join('\n'));
  });

  it('is empty, and the column absent, when only the headline fields are set', () => {
    const c = { wf_windfall_id__c: 'wf-1', wf_net_worth__c: 5 };
    expect(windfallProfile(c)).toBe('');
    expect('Windfall Profile' in windfallColumns(c)).toBe(false);
  });
});

describe('Windfall on People', () => {
  it('contactToPayload carries the Windfall columns', () => {
    const p = contactToPayload({ ...screened, FirstName: 'A', LastName: 'B' }, 'people-historical', { consent: new Map() });
    expect(p.columns['Net Worth']).toBe('12000000');
    expect(p.columns['Windfall Profile']).toEqual({ text: expect.stringContaining('Boat Owner') });
  });

  it('the Contact extract selects every field the transform reads', () => {
    const contacts = buildExtracts(loadConfig()).find((e) => e.name === 'contacts')!;
    for (const f of WINDFALL_FIELDS) expect(contacts.soql, f).toContain(f);
    expect(new Set(WINDFALL_FIELDS).size).toBe(WINDFALL_FIELDS.length);
  });
});
