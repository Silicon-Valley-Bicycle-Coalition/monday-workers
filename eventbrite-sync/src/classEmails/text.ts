// Small text helpers shared by the class email routes (which post the Events-item update) and the
// queue consumer (which writes the timeline entries). Free text only: nothing here logs.
import type { ClassEmailKind } from '../db/classEmails';

export const KIND_LABEL: Record<ClassEmailKind, string> = { reminder: 'Reminder', 'thank-you': 'Thank-you', 'missed-you': 'Missed-you' };

export const MAX_TEXT = 200;

// create_timeline_item's limit on title and summary.
export const MAX_TIMELINE_TEXT = 255;

// Free text from the page, for a Monday update: one line, bounded.
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

// Fills what's known, and leaves anything else as typed so a mistake stays visible.
export function fillPlaceholders(text: string, values: Record<string, string | null>): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, name: string) => values[name] ?? whole);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
