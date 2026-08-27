import type { SourceConfig } from './types';
import type { FetchSourceEvents } from './adapters/dispatch';
import { buildCalendar } from './ics';
import { getLastKnownGoodIcs, setLastKnownGoodIcs, recordSourceSuccess, recordSourceFailure } from './calendarStore';
import { sendFailureAlert as realSendFailureAlert } from './alert';
import { errorMessage } from './util/errorMessage';

const FAILURE_ALERT_THRESHOLD = 3;

export interface CalendarResult {
  /** The ICS text to serve, or null if the source has never succeeded and has no fallback. */
  ics: string | null;
  servedFromFallback: boolean;
}

export interface CalendarSourceDeps {
  kv: KVNamespace;
  fetchSourceEvents: FetchSourceEvents;
  sendFailureAlert: typeof realSendFailureAlert;
  slackWebhookUrl: string;
  now: () => Date;
}

export async function getSourceCalendar(source: SourceConfig, deps: CalendarSourceDeps): Promise<CalendarResult> {
  try {
    const events = await deps.fetchSourceEvents(source, deps.now());
    const ics = buildCalendar(events, source.committeeName);
    await setLastKnownGoodIcs(deps.kv, source.id, ics);
    await recordSourceSuccess(deps.kv, source.id, deps.now().toISOString());
    return { ics, servedFromFallback: false };
  } catch (err) {
    const message = errorMessage(err);
    console.error(`svbc-calendars: source "${source.id}" failed: ${message}`);
    const consecutiveFailures = await recordSourceFailure(deps.kv, source.id, message);
    if (consecutiveFailures === FAILURE_ALERT_THRESHOLD) {
      await deps.sendFailureAlert(deps.slackWebhookUrl, source.id, source.name, consecutiveFailures, message);
    }
    const fallback = await getLastKnownGoodIcs(deps.kv, source.id);
    return { ics: fallback, servedFromFallback: fallback !== null };
  }
}
