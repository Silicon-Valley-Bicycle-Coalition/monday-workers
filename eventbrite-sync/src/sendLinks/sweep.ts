import type { MondayItemColumns } from '../monday/client';
import { errorMessage } from '../util/errorMessage';
import { parseLink, planSendLinks, type SendLink } from './plan';

// The Worker writes the Send event email link only when Eventbrite tells it about an event, so an
// event nobody edits after a link change (a new label, a redeployed page URL, an event imported from
// Salesforce) keeps a stale link or none: on 2026-11-19, 235 of 242 events had no current one and
// staff couldn't find the button. Once a day this reads the Events board and rewrites the stale ones.
// A cron with no cursor: a failed write is simply still stale on the next run.

// Stop after this many failures in a row: Monday is likely down, and tomorrow's run picks it up.
const MAX_CONSECUTIVE_FAILURES = 3;

export interface SendLinkSweepDeps {
  monday: {
    listBoardItems(boardId: number, columnIds: string[]): Promise<MondayItemColumns[]>;
    changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>): Promise<void>;
  };
  boardId: number;
  eventbriteIdColumn: string;
  sendLinkColumn: string;
  pageUrl: string;
  // Under the `off` write switch: plan and count, write nothing.
  dryRun: boolean;
}

export interface SendLinkSweepResult {
  stale: number;
  written: number;
  failed: string[];
  dryRun: boolean;
}

export async function sweepSendLinks(deps: SendLinkSweepDeps): Promise<SendLinkSweepResult> {
  const { monday, boardId, eventbriteIdColumn, sendLinkColumn } = deps;
  const items = await monday.listBoardItems(boardId, [eventbriteIdColumn, sendLinkColumn]);
  const plan = planSendLinks(
    items.map((item) => ({
      itemId: item.id,
      eventbriteId: item.columns[eventbriteIdColumn] ?? '',
      link: parseLink(item.values[sendLinkColumn]),
    })),
    deps.pageUrl,
  );

  const result: SendLinkSweepResult = { stale: plan.toWrite.length, written: 0, failed: [], dryRun: deps.dryRun };
  if (deps.dryRun) return result;

  let consecutiveFailures = 0;
  for (const { itemId, link } of plan.toWrite) {
    try {
      await monday.changeColumnValues(boardId, itemId, { [sendLinkColumn]: link satisfies SendLink });
      result.written++;
      consecutiveFailures = 0;
    } catch (err) {
      console.error(`eventbrite-sync send links: item ${itemId} failed: ${errorMessage(err)}`);
      result.failed.push(itemId);
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
    }
  }
  return result;
}

// Quiet when every link is current, which is most days.
export function logSendLinkSummary(result: SendLinkSweepResult): void {
  if (result.stale === 0) return;
  if (result.dryRun) {
    console.log(`eventbrite-sync send links: ${result.stale} stale (dry run, nothing written)`);
    return;
  }
  const line = `eventbrite-sync send links: ${result.stale} stale, wrote ${result.written}, failed ${result.failed.length}`;
  if (result.failed.length > 0 || result.written < result.stale) console.error(`${line} (${result.failed.join(', ')})`);
  else console.log(line);
}
