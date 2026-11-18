import type { BoardRef, EventRegistrationsConfig, ItRequestsAlertConfig, LoggedActivitiesConfig, PeopleColumns, PromoteConfig, ReclassificationConfig, VolunteersConfig } from './types';

// Validates a config/*.json at startup so a placeholder or a typo fails the first request, not
// the first move. Board ids of 0 are allowed (the production file until cutover) — a pass against
// a 0 board fails loudly at the schema read instead.

type Json = Record<string, unknown>;

function obj(raw: unknown, path: string): Json {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`config: ${path} must be an object`);
  return raw as Json;
}

function str(o: Json, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '') throw new Error(`config: ${path}.${key} must be a non-empty string`);
  return v;
}

function num(o: Json, key: string, path: string, { min = 0, integer = true }: { min?: number; integer?: boolean } = {}): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || (integer && !Number.isInteger(v))) {
    throw new Error(`config: ${path}.${key} must be ${integer ? 'an integer' : 'a number'} >= ${min}`);
  }
  return v;
}

function strList(o: Json, key: string, path: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || s === '')) {
    throw new Error(`config: ${path}.${key} must be an array of non-empty strings`);
  }
  return v as string[];
}

function boardRef(raw: unknown, path: string): BoardRef {
  const o = obj(raw, path);
  const groupId = o.groupId ?? null;
  if (groupId !== null && (typeof groupId !== 'string' || groupId === '')) throw new Error(`config: ${path}.groupId must be a string or null`);
  return { boardId: num(o, 'boardId', path), groupId };
}

function peopleColumns(raw: unknown, path: string): PeopleColumns {
  const o = obj(raw, path);
  const funraiseProfile = o.funraiseProfile ?? null;
  if (funraiseProfile !== null && (typeof funraiseProfile !== 'string' || funraiseProfile === '')) {
    throw new Error(`config: ${path}.funraiseProfile must be a column title or null`);
  }
  return {
    lastGift: str(o, 'lastGift', path), memberUntil: str(o, 'memberUntil', path),
    membershipTier: str(o, 'membershipTier', path), funraiseProfile,
    promoteStatus: str(o, 'promoteStatus', path), promotedOn: str(o, 'promotedOn', path),
  };
}

function eventRegistrations(raw: unknown, path: string): EventRegistrationsConfig | null {
  if (raw === null || raw === undefined) return null;
  const o = obj(raw, path);
  const cols = obj(o.columns, `${path}.columns`);
  const events = obj(o.events, `${path}.events`);
  const config: EventRegistrationsConfig = {
    boardId: num(o, 'boardId', path),
    columns: {
      attendee: str(cols, 'attendee', `${path}.columns`), event: str(cols, 'event', `${path}.columns`),
      attendance: str(cols, 'attendance', `${path}.columns`), source: str(cols, 'source', `${path}.columns`),
    },
    countedAttendanceLabels: strList(o, 'countedAttendanceLabels', path),
    countedRegisteredSources: strList(o, 'countedRegisteredSources', path),
    events: { boardId: num(events, 'boardId', `${path}.events`), startColumn: str(events, 'startColumn', `${path}.events`) },
  };
  if (config.countedAttendanceLabels.length === 0 && config.countedRegisteredSources.length === 0) {
    throw new Error(`config: ${path} counts no registration at all — set countedAttendanceLabels or countedRegisteredSources, or set it to null`);
  }
  return config;
}

function volunteers(raw: unknown, path: string): VolunteersConfig | null {
  if (raw === null || raw === undefined) return null;
  const o = obj(raw, path);
  const cols = obj(o.columns, `${path}.columns`);
  return { boardId: num(o, 'boardId', path), columns: { volunteer: str(cols, 'volunteer', `${path}.columns`), date: str(cols, 'date', `${path}.columns`) } };
}

function loggedActivities(raw: unknown, path: string): LoggedActivitiesConfig | null {
  if (raw === null || raw === undefined) return null;
  const o = obj(raw, path);
  const cols = obj(o.columns, `${path}.columns`);
  const countedTypeLabels = strList(o, 'countedTypeLabels', path);
  if (countedTypeLabels.length === 0) throw new Error(`config: ${path} counts no activity type at all — set countedTypeLabels, or set it to null`);
  return {
    boardId: num(o, 'boardId', path),
    columns: {
      person: str(cols, 'person', `${path}.columns`), date: str(cols, 'date', `${path}.columns`),
      activityType: str(cols, 'activityType', `${path}.columns`),
    },
    countedTypeLabels,
  };
}

function promote(raw: unknown, path: string): PromoteConfig {
  const o = obj(raw, path);
  return { requestLabel: str(o, 'requestLabel', path), doneLabel: str(o, 'doneLabel', path), failedLabel: str(o, 'failedLabel', path) };
}

function itRequests(raw: unknown, path: string): ItRequestsAlertConfig | null {
  if (raw === null || raw === undefined) return null;
  const o = obj(raw, path);
  return {
    boardId: num(o, 'boardId', path, { min: 1 }), typeColumn: str(o, 'typeColumn', path),
    typeLabel: str(o, 'typeLabel', path), cooldownDays: num(o, 'cooldownDays', path, { min: 1 }),
  };
}

export function validateConfig(raw: unknown): ReclassificationConfig {
  const root = obj(raw, 'root');
  const monday = obj(root.monday, 'monday');
  const window = obj(root.window, 'window');
  const boards = obj(root.boards, 'boards');
  const perpetual = obj(root.perpetual, 'perpetual');
  const thresholds = obj(root.thresholds, 'thresholds');
  const run = obj(root.run, 'run');
  const alerts = obj(root.alerts, 'alerts');

  const config: ReclassificationConfig = {
    monday: {
      apiUrl: str(monday, 'apiUrl', 'monday'), accountUrl: str(monday, 'accountUrl', 'monday'),
      // The Monday account a webhook JWT must name (issue GL#110, src/mondayJwt.ts). Optional.
      ...(monday.accountId !== undefined ? { accountId: num(monday, 'accountId', 'monday', { min: 1 }) } : {}),
    },
    window: { years: num(window, 'years', 'window', { min: 1 }), timeZone: str(window, 'timeZone', 'window') },
    boards: { live: boardRef(boards.live, 'boards.live'), historical: boardRef(boards.historical, 'boards.historical') },
    peopleColumns: peopleColumns(root.peopleColumns, 'peopleColumns'),
    perpetual: { lifetimeTierLabel: str(perpetual, 'lifetimeTierLabel', 'perpetual'), funraiseLinked: perpetual.funraiseLinked === true },
    eventRegistrations: eventRegistrations(root.eventRegistrations, 'eventRegistrations'),
    volunteers: volunteers(root.volunteers, 'volunteers'),
    loggedActivities: loggedActivities(root.loggedActivities, 'loggedActivities'),
    promote: promote(root.promote, 'promote'),
    thresholds: {
      itemsLimit: num(thresholds, 'itemsLimit', 'thresholds', { min: 1 }),
      liveTriggerPct: num(thresholds, 'liveTriggerPct', 'thresholds', { min: 1 }),
      historicalWarnPct: num(thresholds, 'historicalWarnPct', 'thresholds', { min: 1 }),
    },
    run: {
      maxMovesPerRun: num(run, 'maxMovesPerRun', 'run', { min: 1 }),
      quarterlyMonths: (() => {
        const v = run.quarterlyMonths;
        if (!Array.isArray(v) || v.length === 0 || v.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) {
          throw new Error('config: run.quarterlyMonths must be a non-empty array of months 1–12');
        }
        return v as number[];
      })(),
      cronHourUTC: num(run, 'cronHourUTC', 'run'),
    },
    alerts: { itRequests: itRequests(alerts.itRequests, 'alerts.itRequests') },
  };
  if (config.thresholds.liveTriggerPct > 100 || config.thresholds.historicalWarnPct > 100) throw new Error('config: thresholds percentages must be <= 100');
  if (config.boards.live.boardId !== 0 && config.boards.live.boardId === config.boards.historical.boardId) {
    throw new Error('config: boards.live and boards.historical must be different boards');
  }
  if (config.perpetual.funraiseLinked && config.peopleColumns.funraiseProfile === null) {
    throw new Error('config: perpetual.funraiseLinked needs peopleColumns.funraiseProfile');
  }
  return config;
}
