// What the staff "Enter a gift" form on the Donations board may show, and a check that a form
// still matches it. Pure and runtime-neutral; scripts/check-donation-form.mjs fetches the form.
//
// Why: a Monday form view lists EVERY column of its board, visible by default. A column a Worker
// adds later (a new 🔒 rollup, an integration id) appears on the form unless someone hides it, and
// a staff member can then overwrite what the Worker writes. A new form view also defaults to
// public, with "Require login" off. Design: docs/superpowers/specs/
// 2026-11-11-manual-donation-entry-form-design.md.

import { bareTitle } from './column-titles.mjs';

// Visible questions, by bare title, and whether each must be required. Names are the *question*
// titles on the form, which may differ from the column titles (the form renames two of them).
export const EXPECTED_QUESTIONS = {
  Name: false,
  Amount: true,
  'Date received': true,
  Status: true,
  'Gift Type': true,
  'Anonymous Donor': false,
  'Payment Method': false,
  'Check/Reference Number': false,
  Donor: false,
  Campaign: false,
  'Thank you already sent?': false,
};

// Pure. `form` is the monday `form(formToken:)` result: { questions: [{ id, type, title, visible,
// required }], features: { requireLogin: { enabled } } }. Returns a list of problems; empty = OK.
export function checkForm(form) {
  const problems = [];
  const visible = new Map();
  for (const q of form.questions ?? []) {
    if (q.type === 'PAGE_BLOCK' || !q.visible) continue;
    visible.set(bareTitle(q.title), q);
  }
  for (const [title, q] of visible) {
    if (!(title in EXPECTED_QUESTIONS)) {
      problems.push(`unexpected visible question "${q.title}" (${q.id}): hide it, or add it to EXPECTED_QUESTIONS if staff should see it`);
    }
  }
  for (const [title, mustBeRequired] of Object.entries(EXPECTED_QUESTIONS)) {
    const q = visible.get(title);
    if (!q) {
      problems.push(`expected question "${title}" is hidden or missing`);
    } else if (mustBeRequired && !q.required) {
      problems.push(`"${title}" should be required`);
    }
  }
  if (form.features?.requireLogin?.enabled !== true) {
    problems.push('Require login to monday.com is off: the form is public to anyone with the link');
  }
  return problems;
}
