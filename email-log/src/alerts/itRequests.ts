import type { AlertKind } from '../db/loggedMessages';
import type { ConsumerDeps } from '../consumer/processBatch';
import { errorText } from '../logSafe';

const DAY_MS = 86_400_000;

/**
 * Opens an IT Requests item (follows people-reclassification's raiseHistoricalAlert), at most once
 * per `cooldownDays` per kind. A no-op while alerts.itRequests is null. Never throws: the alert is
 * a convenience on top of the log line, never a reason to fail a message. `text` must never hold
 * an address or subject.
 */
export async function raiseAlert(kind: AlertKind, text: string, deps: ConsumerDeps): Promise<void> {
  const alert = deps.config.alerts.itRequests;
  if (alert === null) return;
  try {
    const now = deps.now();
    const last = await deps.store.lastAlertAt(kind);
    if (last !== null && now.getTime() - new Date(last).getTime() < alert.cooldownDays * DAY_MS) return;
    const itemId = await deps.monday.createItem(alert.boardId, text, { [alert.typeColumn]: { label: alert.typeLabel } });
    await deps.store.recordAlert(kind, now.toISOString(), itemId);
  } catch (err) {
    console.error(`email-log: IT Requests ${kind} alert failed: ${errorText(err)}`);
  }
}
