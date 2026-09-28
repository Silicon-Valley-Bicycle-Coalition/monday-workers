// Copied from member-portal/src/views.ts (that module pulls in unrelated view-rendering code we
// don't need here) — trivial enough to duplicate rather than share across Workers.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
