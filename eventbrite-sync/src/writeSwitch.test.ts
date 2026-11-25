import { describe, it, expect, vi } from 'vitest';
import { dryRunMondayClient, piiKeysFor } from './writeSwitch';
import { PLACEHOLDER_COLUMN_ID } from './config';
import type { MondayClient } from './monday/client';
import { testConfig } from './test/testConfig';

describe('piiKeysFor', () => {
  it('names the Home Zip column, lowercased, unless it is still the placeholder', () => {
    const cfg = testConfig();
    cfg.attendeeSync.registrations.homeZipColumn = 'Text_ZIP_1';
    expect(piiKeysFor(cfg)).toContain('text_zip_1');
    cfg.attendeeSync.registrations.homeCountyColumn = 'Text_COUNTY_1';
    expect(piiKeysFor(cfg)).toContain('text_county_1');
    cfg.attendeeSync.registrations.homeZipColumn = PLACEHOLDER_COLUMN_ID;
    expect(piiKeysFor(cfg)).not.toContain(PLACEHOLDER_COLUMN_ID.toLowerCase());
  });

  it('keeps a Home Zip out of a debug skip line for a registration write', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const config = testConfig();
    // Neither default list matches this id, so only piiKeysFor can mask it. A real `text_` id would
    // also be cut to its length by FREE_TEXT_KEYS, and the test would pass without piiKeysFor.
    const homeZipColumn = 'col_mm8abcd1';
    config.attendeeSync.registrations.homeZipColumn = homeZipColumn;
    const real = { changeColumnValues: vi.fn(), createItem: vi.fn() } as unknown as MondayClient;
    const ctx = { worker: 'eventbrite-sync', environment: 'sandbox', mode: 'off' as const, logLevel: 'debug' as const, deliveryId: 'd', piiKeys: piiKeysFor(config) };

    await dryRunMondayClient(real, config.monday.boards, ctx).changeColumnValues(333, 'item-1', { [homeZipColumn]: '95112', att_attendance_col: 'Registered' });

    const logged = log.mock.calls.flat().join(' ');
    expect(logged).toContain('changeColumnValues');
    expect(logged).not.toContain('95112');
    log.mockRestore();
  });
});
