import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { descriptionToHtml, fetchOrgNotes, runBackfillOrgNotes } from './orgNotes.js';
import { dataPath, readNdjson } from '../artifacts.js';

const records = [
  { Id: '001A', Name: 'Acme Bikes', Description: 'Called 3/2.\n\nSent <deck> & "terms".', npe01__SYSTEM_AccountType__c: null, LastModifiedDate: '2024-03-02T10:00:00.000+0000' },
  { Id: '001B', Name: 'Blank Co', Description: '  ', LastModifiedDate: '2024-01-01T00:00:00.000+0000' },
  { Id: '001C', Name: 'Pat Doe Household', Description: 'person note', npe01__SYSTEM_AccountType__c: 'One-to-One Individual', LastModifiedDate: '2024-01-01T00:00:00.000+0000' },
  { Id: '001D', Name: 'No Item Org', Description: 'orphan', LastModifiedDate: '2024-01-01T00:00:00.000+0000' },
];
const exec = async () => ({ stdout: JSON.stringify({ status: 0, result: { records } }) });

describe('descriptionToHtml', () => {
  it('escapes HTML and maps blank lines to paragraphs, newlines to <br>', () => {
    expect(descriptionToHtml('a <b>\nc\n\nd & e')).toBe('<p>a &lt;b&gt;<br>c</p><p>d &amp; e</p>');
  });
});

describe('fetchOrgNotes', () => {
  it('keeps organization Descriptions, skipping blanks and person Accounts', async () => {
    const r = await fetchOrgNotes('svbc', exec);
    expect(r.notes.map((n) => n.sfId)).toEqual(['001A', '001D']);
    expect(r.skippedPersons).toBe(1);
  });
});

describe('runBackfillOrgNotes', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });

  const fakeClient = (created: Record<string, unknown>[]) => ({
    gql: async (q: string, v: Record<string, unknown> = {}) => {
      if (q.includes('columns { id title }')) return { boards: [{ columns: [{ id: 'text_sf', title: 'Salesforce ID' }] }] };
      if (q.includes('items_page')) return { boards: [{ items_page: { cursor: null,
        items: [{ id: '900', column_values: [{ text: '001A' }] }] } }] };
      created.push(v);
      return { create_timeline_item: { id: `t${created.length}` } };
    },
  });

  it('writes one timeline entry per matched organization and is idempotent on rerun', async () => {
    const created: Record<string, unknown>[] = [];
    const args = ['--board', '5', '--activity-id', 'act1'];
    expect(await runBackfillOrgNotes(args, { exec, client: fakeClient(created) as never })).toBe(0);
    expect(created).toEqual([expect.objectContaining({ itemId: '900', activityId: 'act1',
      title: 'Salesforce description', timestamp: '2024-03-02T10:00:00.000Z',
      content: '<p>Called 3/2.</p><p>Sent &lt;deck&gt; &amp; "terms".</p>' })]);
    expect(await readNdjson(dataPath('backfill', 'org-notes.ndjson')))
      .toEqual([{ sfId: '001A', itemId: '900', timelineItemId: 't1' }]);
    expect(await runBackfillOrgNotes(args, { exec, client: fakeClient(created) as never })).toBe(0);
    expect(created).toHaveLength(1);
  });

  it('ledgers a failed write and exits 1 without retrying', async () => {
    const client = { gql: async (q: string) => {
      if (q.includes('columns { id title }')) return { boards: [{ columns: [{ id: 'c', title: 'Salesforce ID' }] }] };
      if (q.includes('items_page')) return { boards: [{ items_page: { cursor: null, items: [{ id: '900', column_values: [{ text: '001A' }] }] } }] };
      throw new Error('boom');
    } };
    expect(await runBackfillOrgNotes(['--board', '5', '--activity-id', 'a'], { exec, client: client as never })).toBe(1);
    expect(await readNdjson(dataPath('backfill', 'org-notes.ndjson')))
      .toEqual([{ sfId: '001A', error: 'Error: boom' }]);
  });

  it('requires --activity-id unless dry-run', async () => {
    expect(await runBackfillOrgNotes(['--board', '5'], { exec })).toBe(2);
    expect(await runBackfillOrgNotes(['--board', '5', '--dry-run'], { exec })).toBe(0);
  });
});
