// Money is integer cents everywhere in this Worker (issue GL#27). Summing dollar floats wrote
// values like 714.9300000000001 to Monday; integer cents are exact, and a sum only becomes a
// decimal string at the very last step, when it's written to a Monday numbers column.

// "1,234.5", "$50", "-12.34", "(12.34)" (accounting-style refund), "+5", ".5". Fractions past
// two places round half away from zero on the decimal digits themselves — never via a float,
// where 1.005 * 100 is 100.49999999999999.
const DECIMAL = /^([+-])?(\d*)(?:\.(\d*))?$/;

// Monday's `text` for an Amount cell -> integer cents, or null when the cell is blank or not a
// number at all (callers treat null as malformed, never as $0).
export function parseAmountCents(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  let s = text.trim().replace(/[\s$]/g, '');
  // A comma is a thousands separator only before the decimal point; one after it ("1.234,56",
  // European 1234.56) would otherwise be stripped into a wrong amount.
  if (/\..*,/.test(s)) return null;
  s = s.replace(/,/g, '');
  let negative = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    // "(12.34)" already means negative; a sign inside ("(-5)", "(+5)") is ambiguous.
    if (/^[+-]/.test(paren[1]!)) return null;
    negative = true; s = paren[1]!;
  }

  const m = DECIMAL.exec(s);
  if (m === null) {
    // Scientific notation ("1e3") is the one numeric shape the decimal grammar doesn't cover;
    // only reachable from a hand-typed or API-written cell, so a float round-trip is fine here.
    if (!/^[+-]?(\d+\.?\d*|\.\d+)e[+-]?\d+$/i.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? checked((negative ? -1 : 1) * Math.round(n * 100)) : null;
  }
  const [, sign, whole = '', frac = ''] = m;
  if (whole === '' && frac === '') return null; // "-", "$", "()", "."
  const roundUp = frac.length > 2 && frac.charCodeAt(2) >= 53; // third digit >= '5'
  const magnitude = Number(whole || '0') * 100 + Number(frac.slice(0, 2).padEnd(2, '0')) + (roundUp ? 1 : 0);
  if (sign === '-') negative = !negative;
  return checked(negative ? -magnitude : magnitude);
}

function checked(cents: number): number | null {
  return Number.isSafeInteger(cents) ? (cents === 0 ? 0 : cents) : null; // no -0
}

// Integer cents -> the decimal string written to a Monday numbers column: always exactly two
// places ("714.93", "0.05", "-12.34"), built from integer math so float noise can't creep in.
export function formatCents(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const text = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return cents < 0 && abs !== 0 ? `-${text}` : text;
}
