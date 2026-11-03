import type { EmailLogConfig } from '../types';

export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function merge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const current = out[key];
    out[key] = isPlainObject(value) && isPlainObject(current) ? merge(current, value) : value;
  }
  return out;
}

// One valid config for tests to start from, so each suite overrides only what it exercises.
// Ids are deliberately fake; config/sandbox.json has the real sandbox ids. Arrays and null
// replace the default wholesale rather than merging.
export function testConfig(overrides: DeepPartial<EmailLogConfig> = {}): EmailLogConfig {
  const base: EmailLogConfig = {
    monday: {
      apiUrl: 'https://api.monday.com/v2',
      accountUrl: 'https://example.monday.com',
      boards: { 'activities-logged': 111, 'people-live': 42, 'people-historical': 43, affiliations: 44 },
    },
    activities: {
      activityTypeColumn: 'type_col',
      activityTypeLabel: 'Email',
      dateColumn: 'date_col',
      statusColumn: 'status_col',
      doneLabel: 'Done',
      needsPersonLabel: 'Needs Person',
      ownerColumn: 'owner_col',
      personColumn: 'person_col',
      notesColumn: 'notes_col',
      messageHashColumn: 'hash_col',
    },
    matching: {
      peopleEmailColumns: ['personal_email_col', 'household_email_col'],
      historicalEmailColumns: ['hist_personal_email_col', 'hist_household_email_col'],
      affiliationsWorkEmailColumn: 'work_email_col',
      affiliationsPersonColumn: 'aff_person_col',
    },
    mail: {
      loggingAddress: 'log@log.example.org',
      staffDomains: ['example.org'],
      staffSenders: [],
      trustedAuthServId: 'mx.example.net',
      bodyMaxChars: 1900,
      maxRawBytes: 10_000_000,
      forwardTimeZone: 'America/Los_Angeles',
      replyFrom: { email: 'noreply@mail.example.org', name: 'Monday Log' },
    },
    capacity: { activitiesMaxItems: 100000, warnPct: 95 },
    alerts: { itRequests: null },
  };
  return merge(base as unknown as Record<string, unknown>, overrides as Record<string, unknown>) as unknown as EmailLogConfig;
}
