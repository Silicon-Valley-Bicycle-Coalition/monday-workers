// Resolves a label's display text to its numeric id from a column's raw `settings_str`.
// Verified against live sandbox data (2026-09-20): status columns store labels as an
// id-keyed object ({"<id>": "<text>", ...}); dropdown columns store an array of {id, name}.
// Ids are NOT guaranteed sequential (Monday assigns them at creation and they persist across
// label reorders), so this must read the column's actual current settings rather than assume
// creation order.
export function resolveLabelId(columnType: string, settingsStr: string, labelText: string): number | undefined {
  let settings: unknown;
  try { settings = JSON.parse(settingsStr || '{}'); } catch { return undefined; }
  if (columnType === 'status') {
    const labels = (settings as { labels?: Record<string, string> }).labels ?? {};
    for (const [id, text] of Object.entries(labels)) if (text === labelText) return Number(id);
    return undefined;
  }
  if (columnType === 'dropdown') {
    const labels = (settings as { labels?: { id: number; name: string }[] }).labels ?? [];
    return labels.find((l) => l.name === labelText)?.id;
  }
  return undefined;
}

// Monday treats status label id 5 as an EMPTY cell's default: the API returns that label as the
// blank cell's `text` (value null), so a real label there makes every unset item read as having
// it (sandbox Events: every item without a Program read "Fundraiser"). Key the labels 0..4, 6..n,
// never 5, so blank stays blank.
export const EMPTY_STATUS_LABEL_ID = 5;

export function statusLabelIds(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i < EMPTY_STATUS_LABEL_ID ? i : i + 1));
}

// create_column `defaults` for a status column seeded with exactly `labels`, in display order.
export function statusLabelDefaults(labels: readonly string[]): string {
  const ids = statusLabelIds(labels.length);
  return JSON.stringify({ labels: Object.fromEntries(labels.map((label, i) => [ids[i], label])) });
}
