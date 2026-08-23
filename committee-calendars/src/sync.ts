import type { EventStore } from './db/events';
import type { CommitteeCalendarsConfig } from './types';
import type { FetchSourceEvents } from './adapters/dispatch';
import { sendFailureAlert } from './alert';
import { errorMessage } from './util/errorMessage';

const FAILURE_ALERT_THRESHOLD = 3;

export interface SyncDeps {
  eventStore: EventStore;
  config: CommitteeCalendarsConfig;
  slackWebhookUrl: string;
  now: Date;
  fetchSourceEvents: FetchSourceEvents;
}

export async function syncAllSources(deps: SyncDeps): Promise<void> {
  const todayUtc = deps.now.toISOString();

  for (const source of deps.config.sources) {
    try {
      const events = await deps.fetchSourceEvents(source, deps.now);
      await deps.eventStore.replaceSourceEvents(source.id, events, todayUtc);
      await deps.eventStore.recordSourceSuccess(source.id, todayUtc);
    } catch (err) {
      const message = errorMessage(err);
      console.error(`committee-calendars sync: source "${source.id}" failed: ${message}`);
      const consecutiveFailures = await deps.eventStore.recordSourceFailure(source.id, message);
      if (consecutiveFailures === FAILURE_ALERT_THRESHOLD) {
        await sendFailureAlert(deps.slackWebhookUrl, source.id, source.name, consecutiveFailures, message);
      }
    }
  }
}
