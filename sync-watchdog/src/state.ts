// Alert-on-change: a subject posts when it goes bad, once a day while it stays bad, and once when
// it recovers. Pure; src/run.ts loads and saves the states and marks an alert sent only after
// Slack accepted it, so a failed POST is retried on the next run.

export type Health = { ok: true } | { ok: false; detail: string };

export interface SubjectState {
  armedAt: string; // first time the watchdog saw this subject
  bad: boolean;
  lastAlertAt: string | null; // last bad/reminder alert Slack accepted while bad
  detail: string | null;
}

export type Decision = {
  post: null | { kind: 'bad' | 'reminder' | 'recovered'; text: string };
  next: SubjectState;
};

const REMINDER_MS = 24 * 60 * 60 * 1000;

export function decide(subject: string, health: Health, prev: SubjectState | null, now: Date): Decision {
  const nowIso = now.toISOString();
  if (prev === null) {
    // First sight only arms the subject: its history isn't known yet.
    return { post: null, next: { armedAt: nowIso, bad: !health.ok, lastAlertAt: null, detail: health.ok ? null : health.detail } };
  }
  if (health.ok) {
    if (!prev.bad) return { post: null, next: prev };
    // Never announced as bad (Slack failed, or it cleared before the next run): stay quiet.
    if (prev.lastAlertAt === null) return { post: null, next: { ...prev, bad: false, detail: null } };
    return {
      post: { kind: 'recovered', text: `sync-watchdog: ${subject} recovered` },
      next: { ...prev, bad: false, lastAlertAt: null, detail: null },
    };
  }
  const next: SubjectState = { ...prev, bad: true, detail: health.detail };
  if (!prev.bad || prev.lastAlertAt === null) {
    return { post: { kind: 'bad', text: `sync-watchdog: ${subject}: ${health.detail}` }, next };
  }
  if (now.getTime() - Date.parse(prev.lastAlertAt) >= REMINDER_MS) {
    return { post: { kind: 'reminder', text: `sync-watchdog: ${subject} still failing: ${health.detail}` }, next };
  }
  return { post: null, next };
}

export function markSent(next: SubjectState, now: Date): SubjectState {
  return { ...next, lastAlertAt: now.toISOString() };
}
