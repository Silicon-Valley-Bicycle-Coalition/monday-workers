export interface ForwardBlock {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  dateISO: string | null;
  messageId: string | null;
  body: string;
}

const MARKER = /^-{5,}\s*Forwarded message\s*-{5,}\s*$/i;
// Apple Mail (macOS, iOS) opens its forward with this line; the block below it, and the whole
// forwarded message, is usually quoted with "> " in text/plain.
const APPLE_MARKER = /^((?:>[ \t]?)*)Begin forwarded message:\s*$/i;
const HEADER = /^([A-Za-z][A-Za-z-]*):[ \t]*(.*)$/;

/** Splits a header address list on commas outside quotes and angle brackets. */
function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angled = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angled = true;
    else if (!quoted && ch === '>') angled = false;
    if (ch === ',' && !quoted && !angled) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function entryAddress(entry: string): string | null {
  const angle = /<([^<>]*)>/.exec(entry);
  const raw = angle ? angle[1]! : (/\S+@\S+/.exec(entry)?.[0] ?? '');
  const addr = raw.replace(/^[\s"'(),;:<>]+|[\s"'(),;:<>]+$/g, '').toLowerCase();
  return addr.includes('@') ? addr : null;
}

/** Lowercased bare addresses from a header address list; entries without an address are dropped. */
export function parseAddressList(value: string): string[] {
  return splitAddressList(value).flatMap((entry) => entryAddress(entry) ?? []);
}

/** True when the line is nothing but address-list entries (display name optional). */
function isAddressOnly(line: string): boolean {
  const entries = splitAddressList(line).filter((e) => e.trim() !== '');
  return (
    entries.length > 0 &&
    entries.every((e) => /^\s*(?:"[^"]*"\s*|[^<>,"@:]*?\s)?<[^<>\s]+@[^<>\s]+>\s*$|^\s*[^\s,<>"]+@[^\s,<>"]+\s*$/.test(e))
  );
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock fields read in timeZone, as an ISO instant; null for an invalid date or zone. */
function wallTimeISO(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): string | null {
  const wall = Date.UTC(year, month, day, hour, minute, second);
  const check = new Date(wall);
  if (check.getUTCMonth() !== month || check.getUTCDate() !== day) return null;
  try {
    let utc = wall - zoneOffsetMs(wall, timeZone);
    utc = wall - zoneOffsetMs(utc, timeZone);
    return new Date(utc).toISOString();
  } catch {
    return null;
  }
}

function hour24(h12: number, meridiem: string): number {
  return (h12 % 12) + (meridiem.toUpperCase() === 'PM' ? 12 : 0);
}

/** Gmail's "Mon, Oct 19, 2026 at 3:04 PM" (weekday optional), read as wall time in timeZone. */
function parseGmailDate(value: string, timeZone: string): string | null {
  const m = /^(?:[A-Za-z]{3},\s+)?([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(value.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  const h12 = Number(m[4]);
  const minute = Number(m[5]);
  if (month < 0 || h12 < 1 || h12 > 12 || minute > 59) return null;
  return wallTimeISO(Number(m[3]), month, Number(m[2]), hour24(h12, m[6]!), minute, 0, timeZone);
}

// Hours from UTC for the abbreviations Apple Mail writes for North American zones.
const ZONE_HOURS: Record<string, number> = {
  UTC: 0, GMT: 0, UT: 0,
  EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7,
  AKST: -9, AKDT: -8, HST: -10,
};

/** Minutes from UTC for "PST", "GMT", "GMT-8", "UTC+05:30" or "-0800"; null when unknown. */
function zoneOffsetMinutes(zone: string): number | null {
  const upper = zone.toUpperCase();
  if (upper in ZONE_HOURS) return ZONE_HOURS[upper]! * 60;
  const m = /^(?:GMT|UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(upper);
  if (!m) return null;
  const hours = Number(m[2]);
  const minutes = Number(m[3] ?? 0);
  if (hours > 14 || minutes > 59) return null;
  return (m[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

/**
 * Apple Mail's "November 2, 2026 at 13:58:55 PST" (weekday optional; 12-hour "1:58:55 PM" too;
 * seconds optional). The zone in the line wins; with none, the time is read in timeZone.
 */
function parseAppleDate(value: string, timeZone: string): string | null {
  const m =
    /^(?:[A-Za-z]+,\s+)?([A-Za-z]{3,})\.?\s+(\d{1,2}),\s+(\d{4}),?\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP]M))?(?:\s+(\S+))?$/i.exec(
      value.trim(),
    );
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const month = MONTH_NAMES.findIndex((full) => full.startsWith(name));
  if (month < 0) return null;
  const year = Number(m[3]);
  const day = Number(m[2]);
  const rawHour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] ?? 0);
  if (m[7] ? rawHour < 1 || rawHour > 12 : rawHour > 23) return null;
  if (minute > 59 || second > 59) return null;
  const hour = m[7] ? hour24(rawHour, m[7]) : rawHour;
  if (!m[8]) return wallTimeISO(year, month, day, hour, minute, second, timeZone);
  const offset = zoneOffsetMinutes(m[8]);
  if (offset === null) return null;
  const utc = wallTimeISO(year, month, day, hour, minute, second, 'UTC');
  return utc && new Date(Date.parse(utc) - offset * 60_000).toISOString();
}

/** Strips up to depth levels of "> " quoting from a line; unquoted lines pass through. */
function unquote(line: string, depth: number): string {
  let out = line;
  for (let d = 0; d < depth && out.startsWith('>'); d++) out = out.replace(/^>[ \t]?/, '');
  return out;
}

/** Finds the first Gmail or Apple Mail forward marker: its line index, kind and quote depth. */
function findMarker(lines: string[]): { start: number; apple: boolean; depth: number } | null {
  for (let i = 0; i < lines.length; i++) {
    if (MARKER.test(lines[i]!.trim())) return { start: i, apple: false, depth: 0 };
    const apple = APPLE_MARKER.exec(lines[i]!.trim());
    if (apple) return { start: i, apple: true, depth: (apple[1]!.match(/>/g) ?? []).length };
  }
  return null;
}

/**
 * Parses the first forward block, Gmail's "Forwarded message" or Apple Mail's "Begin forwarded
 * message:" (with the "> " quoting its marker line carries removed from the lines after it); null
 * when absent or without a From.
 */
export function parseForwardBlock(text: string, timeZone: string): ForwardBlock | null {
  const raw = text.split(/\r?\n/);
  const marker = findMarker(raw);
  if (!marker) return null;
  const { start, apple, depth } = marker;
  const lines = raw.map((l, i) => (i > start ? unquote(l, depth) : l));

  const headers = new Map<string, string>();
  let lastKey: string | null = null;
  let i = start + 1;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  let bodyStart = i;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') {
      bodyStart = i + 1;
      break;
    }
    const prev = lastKey ? headers.get(lastKey)! : '';
    const addressKey = lastKey === 'to' || lastKey === 'cc';
    const continuation =
      lastKey !== null && (/^\s/.test(line) || (addressKey && (prev.endsWith(',') || isAddressOnly(line))));
    if (continuation) {
      headers.set(lastKey!, `${prev} ${line.trim()}`);
      continue;
    }
    const h = HEADER.exec(line);
    if (!h) {
      bodyStart = i;
      break;
    }
    lastKey = h[1]!.toLowerCase();
    if (!headers.has(lastKey)) headers.set(lastKey, h[2]!.trim());
    bodyStart = i + 1;
  }

  const from = parseAddressList(headers.get('from') ?? '')[0];
  if (!from) return null;
  const date = headers.get('date');
  return {
    from,
    to: parseAddressList(headers.get('to') ?? ''),
    cc: parseAddressList(headers.get('cc') ?? ''),
    subject: headers.get('subject') ?? '',
    dateISO: date ? (apple ? parseAppleDate : parseGmailDate)(date, timeZone) : null,
    messageId: headers.get('message-id') ?? null,
    body: lines.slice(bodyStart).join('\n').trim(),
  };
}
