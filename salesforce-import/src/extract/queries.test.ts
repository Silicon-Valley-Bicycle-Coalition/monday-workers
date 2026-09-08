import { describe, it, expect } from 'vitest';
import { buildExtracts } from './queries.js';
import { loadConfig } from '../config.js';

describe('buildExtracts', () => {
  it('pulls the Affiliation fields the Affiliations board needs', () => {
    const affil = buildExtracts(loadConfig()).find((e) => e.name === 'affiliations')!;
    const soql = affil.soql.replace(/\s+/g, ' ');
    for (const field of ['npe5__Role__c', 'npe5__Status__c', 'npe5__StartDate__c', 'npe5__EndDate__c',
      'npe5__Primary__c', 'npe5__Description__c', 'CreatedDate', 'CreatedBy.Name',
      'LastModifiedDate', 'LastModifiedBy.Name']) {
      expect(soql, field).toContain(field);
    }
    expect(affil.backupOnly).toBeFalsy();
  });
});
