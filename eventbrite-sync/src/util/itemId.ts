// A Monday connect column takes numeric item ids. Real ids are numeric strings; a write-switch dry
// run links to placeholder ids (`dry-run-1`, src/writeSwitch.ts), which Number() would turn into
// NaN and the skip line would log as null. A non-numeric id passes through unchanged so the line
// shows which placeholder the link points at.
export function linkedItemId(id: string): number | string {
  const n = Number(id);
  return Number.isFinite(n) ? n : id;
}
