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
