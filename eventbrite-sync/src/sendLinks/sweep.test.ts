import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MondayItemColumns } from '../monday/client';
import { logSendLinkSummary, sweepSendLinks, type SendLinkSweepDeps } from './sweep';
import { sendLink } from './plan';

const PAGE = 'https://example.org/classes';
const ID_COL = 'eb_id';
const LINK_COL = 'send_link';

function item(id: string, eventbriteId: string, link: { url: string; text: string } | null = null): MondayItemColumns {
  return {
    id,
    name: `Event ${id}`,
    state: 'active',
    columns: { [ID_COL]: eventbriteId, [LINK_COL]: link ? `${link.text} - ${link.url}` : '' },
    values: { [ID_COL]: eventbriteId ? JSON.stringify(eventbriteId) : null, [LINK_COL]: link ? JSON.stringify({ ...link, changed_at: '2026-11-04T00:00:00Z' }) : null },
  };
}

function deps(items: MondayItemColumns[], overrides: Partial<SendLinkSweepDeps> = {}) {
  const changeColumnValues = vi.fn<SendLinkSweepDeps['monday']['changeColumnValues']>().mockResolvedValue(undefined);
  const listBoardItems = vi.fn<SendLinkSweepDeps['monday']['listBoardItems']>().mockResolvedValue(items);
  return {
    changeColumnValues,
    listBoardItems,
    deps: { monday: { listBoardItems, changeColumnValues }, boardId: 42, eventbriteIdColumn: ID_COL, sendLinkColumn: LINK_COL, pageUrl: PAGE, dryRun: false, ...overrides },
  };
}

describe('sweepSendLinks', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rewrites missing and outdated links, and leaves current ones and non-Eventbrite items alone', async () => {
    const { deps: d, changeColumnValues, listBoardItems } = deps([
      item('1', '9001'),
      item('2', '9002', { url: `${PAGE}?event=9002`, text: 'Send class email' }),
      item('3', '9003', { url: 'https://old.example/page?event=9003', text: 'Send event email' }),
      item('4', '9004', sendLink(PAGE, '9004')),
      item('5', ''),
    ]);
    const result = await sweepSendLinks(d);
    expect(listBoardItems).toHaveBeenCalledWith(42, [ID_COL, LINK_COL]);
    expect(changeColumnValues.mock.calls).toEqual([
      [42, '1', { [LINK_COL]: sendLink(PAGE, '9001') }],
      [42, '2', { [LINK_COL]: sendLink(PAGE, '9002') }],
      [42, '3', { [LINK_COL]: sendLink(PAGE, '9003') }],
    ]);
    expect(result).toEqual({ stale: 3, written: 3, failed: [], dryRun: false });
  });

  it('counts but writes nothing on a dry run', async () => {
    const { deps: d, changeColumnValues } = deps([item('1', '9001')], { dryRun: true });
    expect(await sweepSendLinks(d)).toEqual({ stale: 1, written: 0, failed: [], dryRun: true });
    expect(changeColumnValues).not.toHaveBeenCalled();
  });

  it('carries on past a failed item', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps: d, changeColumnValues } = deps([item('1', '9001'), item('2', '9002')]);
    changeColumnValues.mockRejectedValueOnce(new Error('item gone'));
    expect(await sweepSendLinks(d)).toEqual({ stale: 2, written: 1, failed: ['1'], dryRun: false });
  });

  it('stops after three failures in a row, leaving the rest for the next run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps: d, changeColumnValues } = deps(['1', '2', '3', '4', '5'].map((n) => item(n, `900${n}`)));
    changeColumnValues.mockRejectedValue(new Error('HTTP 503'));
    const result = await sweepSendLinks(d);
    expect(changeColumnValues).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ stale: 5, written: 0, failed: ['1', '2', '3'], dryRun: false });
  });
});

describe('logSendLinkSummary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is quiet when nothing is stale', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    logSendLinkSummary({ stale: 0, written: 0, failed: [], dryRun: false });
    expect(log).not.toHaveBeenCalled();
  });

  it('logs writes, and an error when some were left unwritten', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSendLinkSummary({ stale: 2, written: 2, failed: [], dryRun: false });
    expect(log).toHaveBeenCalledWith('eventbrite-sync send links: 2 stale, wrote 2, failed 0');
    logSendLinkSummary({ stale: 5, written: 0, failed: ['1', '2', '3'], dryRun: false });
    expect(error).toHaveBeenCalledWith('eventbrite-sync send links: 5 stale, wrote 0, failed 3 (1, 2, 3)');
  });

  it('says a dry run wrote nothing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    logSendLinkSummary({ stale: 4, written: 0, failed: [], dryRun: true });
    expect(log).toHaveBeenCalledWith('eventbrite-sync send links: 4 stale (dry run, nothing written)');
  });
});
