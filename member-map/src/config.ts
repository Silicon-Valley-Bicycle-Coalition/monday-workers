// Validates a config/*.json at startup so a typo fails the first run, not a silent Monday
// morning. Board ids of 0 are allowed (the production file until cutover); a read against a 0
// board fails loudly at the board read instead.

export interface MapConfig {
  monday: { apiUrl: string; accountUrl: string };
  boards: { peopleLive: number; peopleHistorical: number; organizations: number }; // 0 = placeholder
  // Bare column titles (no 🔒/📜 marker); match with bareTitle.
  columns: {
    address: string; city: string; zip: string; lat: string; lng: string;
    membershipStatus: string; doNotSolicit: string;
  };
  // Membership Status labels: activeLabel is a member, lapsedLabel a lapsed member; any other
  // value (or blank) on a People board is a never-member.
  activeLabel: string;
  lapsedLabel: string;
  geocoder: {
    url: string; benchmark: string; defaultState: string;
    batchSize: number; maxPerRun: number; retryNoMatchDays: number;
    // Per Census request (abort after), and for all of a run's geocoding together: once spent, the
    // remaining addresses wait for the next run, so the snapshot is always written in time.
    timeoutMs: number; budgetMs: number;
  };
  // teamDomain "" = Cloudflare Access not set up yet; the gate then refuses every request.
  access: { teamDomain: string; aud: string; allowedEmailDomain: string };
}

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

function int(o: Json, key: string, path: string, min: number): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new Error(`config: ${path}.${key} must be an integer >= ${min}`);
  return v;
}

function httpsUrl(o: Json, key: string, path: string): string {
  const v = str(o, key, path);
  if (!v.startsWith('https://')) throw new Error(`config: ${path}.${key} must start with https://`);
  return v;
}

// Bare lowercase domain, matched exactly against the part after an address's last @.
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function validateConfig(raw: unknown): MapConfig {
  const root = obj(raw, 'config');

  const monday = obj(root.monday, 'monday');
  const boards = obj(root.boards, 'boards');
  const columns = obj(root.columns, 'columns');
  const geocoder = obj(root.geocoder, 'geocoder');
  const access = obj(root.access, 'access');

  const teamDomain = typeof access.teamDomain === 'string' && access.teamDomain === '' ? '' : httpsUrl(access, 'teamDomain', 'access');
  const allowedEmailDomain = str(access, 'allowedEmailDomain', 'access');
  if (!DOMAIN.test(allowedEmailDomain)) throw new Error('config: access.allowedEmailDomain must be a lowercase domain, without @');
  if (typeof access.aud !== 'string') throw new Error('config: access.aud must be a string');

  return {
    monday: { apiUrl: httpsUrl(monday, 'apiUrl', 'monday'), accountUrl: httpsUrl(monday, 'accountUrl', 'monday') },
    boards: {
      peopleLive: int(boards, 'peopleLive', 'boards', 0),
      peopleHistorical: int(boards, 'peopleHistorical', 'boards', 0),
      organizations: int(boards, 'organizations', 'boards', 0),
    },
    columns: {
      address: str(columns, 'address', 'columns'),
      city: str(columns, 'city', 'columns'),
      zip: str(columns, 'zip', 'columns'),
      lat: str(columns, 'lat', 'columns'),
      lng: str(columns, 'lng', 'columns'),
      membershipStatus: str(columns, 'membershipStatus', 'columns'),
      doNotSolicit: str(columns, 'doNotSolicit', 'columns'),
    },
    activeLabel: str(root, 'activeLabel', 'config'),
    lapsedLabel: str(root, 'lapsedLabel', 'config'),
    geocoder: {
      url: httpsUrl(geocoder, 'url', 'geocoder'),
      benchmark: str(geocoder, 'benchmark', 'geocoder'),
      defaultState: str(geocoder, 'defaultState', 'geocoder'),
      batchSize: int(geocoder, 'batchSize', 'geocoder', 1),
      maxPerRun: int(geocoder, 'maxPerRun', 'geocoder', 1),
      retryNoMatchDays: int(geocoder, 'retryNoMatchDays', 'geocoder', 0),
      timeoutMs: int(geocoder, 'timeoutMs', 'geocoder', 1),
      budgetMs: int(geocoder, 'budgetMs', 'geocoder', 1),
    },
    access: { teamDomain, aud: access.aud, allowedEmailDomain },
  };
}
