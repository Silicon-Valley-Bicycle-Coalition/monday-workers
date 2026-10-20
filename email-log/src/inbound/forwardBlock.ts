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

/** Gmail's "Mon, Oct 19, 2026 at 3:04 PM" (weekday optional), read as wall time in timeZone. */
function parseGmailDate(value: string, timeZone: string): string | null {
  const m = /^(?:[A-Za-z]{3},\s+)?([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(value.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  const day = Number(m[2]);
  const year = Number(m[3]);
  const h12 = Number(m[4]);
  const minute = Number(m[5]);
  if (month < 0 || h12 < 1 || h12 > 12 || minute > 59) return null;
  const hour = (h12 % 12) + (m[6]!.toUpperCase() === 'PM' ? 12 : 0);
  const wall = Date.UTC(year, month, day, hour, minute);
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

/** Parses the first Gmail "Forwarded message" block; null when absent or without a From. */
export function parseForwardBlock(text: string, timeZone: string): ForwardBlock | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => MARKER.test(l.trim()));
  if (start < 0) return null;

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
    dateISO: date ? parseGmailDate(date, timeZone) : null,
    messageId: headers.get('message-id') ?? null,
    body: lines.slice(bodyStart).join('\n').trim(),
  };
}
