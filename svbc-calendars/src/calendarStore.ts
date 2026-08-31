import type { SourceStatus } from './types';

const DEFAULT_STATUS: SourceStatus = { consecutiveFailures: 0, lastError: null, lastSuccessAt: null };

export async function getLastKnownGoodIcs(kv: KVNamespace, sourceId: string): Promise<string | null> {
  return kv.get(`ics:${sourceId}`);
}

export async function setLastKnownGoodIcs(kv: KVNamespace, sourceId: string, icsText: string): Promise<void> {
  await kv.put(`ics:${sourceId}`, icsText);
}

export async function getSourceStatus(kv: KVNamespace, sourceId: string): Promise<SourceStatus> {
  const raw = await kv.get(`status:${sourceId}`);
  return raw ? (JSON.parse(raw) as SourceStatus) : DEFAULT_STATUS;
}

export async function recordSourceSuccess(kv: KVNamespace, sourceId: string, nowIso: string): Promise<void> {
  const status: SourceStatus = { consecutiveFailures: 0, lastError: null, lastSuccessAt: nowIso };
  await kv.put(`status:${sourceId}`, JSON.stringify(status));
}

export async function recordSourceFailure(kv: KVNamespace, sourceId: string, errorMsg: string): Promise<number> {
  const previous = await getSourceStatus(kv, sourceId);
  const status: SourceStatus = { consecutiveFailures: previous.consecutiveFailures + 1, lastError: errorMsg, lastSuccessAt: previous.lastSuccessAt };
  await kv.put(`status:${sourceId}`, JSON.stringify(status));
  return status.consecutiveFailures;
}

export async function getAllSourceStatuses(kv: KVNamespace, sourceIds: string[]): Promise<Record<string, SourceStatus>> {
  const entries = await Promise.all(sourceIds.map(async (id) => [id, await getSourceStatus(kv, id)] as const));
  return Object.fromEntries(entries);
}
