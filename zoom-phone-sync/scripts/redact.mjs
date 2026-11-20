// Turns a captured Zoom webhook delivery into a test fixture (#50): keeps the shape, types and
// timestamps, replaces every person-identifying value. Replacements are consistent within one
// redactor, so the same number or user id maps to the same stand-in across a delivery (or several
// deliveries passed to the same redactor): an inbound and outbound call to one contact still match.
//
// Pure, with no Node imports, so the Worker's vitest (workerd) can test it; the CLI is
// redact-capture.mjs.

// Keys whose string value is free text from a person: always replaced outright.
const TEXT_KEYS = new Set(['message', 'text', 'body', 'content', 'subject']);
// Keys left as they are: enums, timestamps, durations and event names carry no personal data.
const KEEP_KEYS = new Set([
  'event', 'event_ts', 'direction', 'connect_type', 'result', 'call_type', 'type', 'message_type',
  'start_time', 'end_time', 'answer_time', 'date_time', 'talk_time', 'duration', 'hold_time',
  'waiting_time', 'ringing_time', 'event_time', 'record_type', 'call_end_time', 'call_start_time',
  'timezone', 'country_iso_code', 'country_code', 'site_name', 'department', 'cost_center',
  'device_type', 'hide_caller_id', 'end_to_end', 'is_encrypted',
]);

const E164 = /^\+?\d{7,15}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function createRedactor() {
  const maps = { phone: new Map(), ext: new Map(), name: new Map(), email: new Map(), id: new Map() };
  const review = new Set();

  function stand(kind, value, make) {
    const map = maps[kind];
    if (!map.has(value)) map.set(value, make(map.size + 1));
    return map.get(value);
  }
  // Fictional NANP numbers: 555-0100 through 555-0199 are reserved for fiction.
  const phone = (v) => stand('phone', v, (n) => `+14085550${100 + (n % 100)}`);
  const ext = (v) => stand('ext', String(v), (n) => String(100 + n));
  const name = (v) => stand('name', v, (n) => `Person ${n}`);
  const email = (v) => stand('email', v, (n) => `person${n}@example.org`);
  // One stand-in per value whatever key it turns up under (an SMS's owner.id is a to_members
  // user_id), labelled and numbered by the key it was first seen under: call_id_1, user_id_1.
  const idCounts = new Map();
  const id = (key, v) => {
    if (!maps.id.has(v)) {
      const n = (idCounts.get(key) ?? 0) + 1;
      idCounts.set(key, n);
      maps.id.set(v, `${key}_${n}`);
    }
    return maps.id.get(v);
  };

  function redactValue(key, value, path) {
    if (Array.isArray(value)) return value.map((v, i) => redactValue(key, v, `${path}[${i}]`));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(k, v, `${path}.${k}`)]));
    }
    const k = key.toLowerCase();
    if (KEEP_KEYS.has(k)) return value;
    if (typeof value === 'number' && /ext/.test(k)) return Number(ext(value));
    if (typeof value !== 'string' || value === '') return value;

    if (TEXT_KEYS.has(k)) return 'REDACTED MESSAGE TEXT';
    if (EMAIL.test(value)) return email(value);
    if (/ext/.test(k) && /^\d{1,6}$/.test(value)) return ext(value);
    if (/(number|phone|did)/.test(k)) return phone(value);
    if (/name/.test(k)) return name(value);
    // Before the bare-number check: Zoom ids are often long digit strings.
    if (k === 'id' || k.endsWith('_id') || k.endsWith('id')) return id(k, value);
    if (E164.test(value)) return phone(value);

    // Anything else is a string we have no rule for: keep it, but list it for a human to check.
    review.add(path);
    return value;
  }

  return {
    redact: (delivery) => redactValue('', delivery, '$'),
    // JSON paths of strings left unchanged that no rule recognized. Check each before committing.
    needsReview: () => [...review].sort(),
  };
}
