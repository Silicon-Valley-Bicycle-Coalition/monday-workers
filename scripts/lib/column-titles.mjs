// Read-only markers on Monday column titles, and title matching that ignores them.
//
// Staff see "🔒 Lifetime Giving" (a Worker rewrites it; a hand edit is overwritten) or
// "📜 Salesforce ID" (import-only history; keep for the audit trail). Monday has no per-column
// lock that binds people but not the Workers' tokens, so the title is the reminder. Code keeps
// naming the bare title ("Lifetime Giving") and resolves it with bareTitle / sameTitle, so a
// marker added or removed in Monday never breaks a lookup and never makes an idempotent setup
// script create a duplicate column. scripts/mark-read-only-columns.mjs applies the markers.
//
// Imported directly by Workers and scripts (as monday-auth imports token-scope.mjs); types are in
// column-titles.d.mts.

export const LOCKED = '🔒';
export const HISTORY = '📜';

// One leading marker, an optional emoji variation selector (U+FE0F), then whitespace.
const MARKER = /^(?:🔒|📜)️?\s+/u;

export function bareTitle(title) {
  return title.replace(MARKER, '');
}

export function markedTitle(title, marker) {
  return `${marker} ${bareTitle(title)}`;
}

export function sameTitle(a, b) {
  return bareTitle(a) === bareTitle(b);
}
