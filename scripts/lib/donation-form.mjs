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
  'Pledge date': true,
  'Gift Type': true,
  'Anonymous Donor': false,
  'Payment Method': false,
  'Check/Reference Number': false,
  Donor: false,
  Campaign: false,
};

// Questions that must be a particular type. Gift Type is a pick list of the Status column's labels
// (2026-11-20); a ShortText "Gift Type" means the old text column's question is showing again.
export const EXPECTED_TYPES = { 'Gift Type': 'SingleSelect' };

// A pledge is promised, not paid: choosing Pledged swaps the payment questions for Pledge date, so
// Date stays blank until the money arrives and the gift counts in no total. Design: docs/superpowers/
// specs/2026-11-24-pledges-and-invoices-design.md. Every other visible question is always shown.
export const PLEDGED = 'Pledged';
export const SHOWN_FOR = {
  'Pledge date': 'pledged',
  'Date received': 'not-pledged',
  'Payment Method': 'not-pledged',
  'Check/Reference Number': 'not-pledged',
};

const conditionsOf = (question) => (question.showIfRules?.rules ?? []).flatMap((r) => r.conditions ?? []);
const visibleLabels = (statusQuestion) => (statusQuestion?.options ?? []).filter((o) => o.visible).map((o) => o.label);

// Pure. The visible Status labels that show `question`, in Status order; null = always shown.
export function shownForLabels(question, statusQuestion) {
  const conditions = conditionsOf(question);
  if (conditions.length === 0) return null;
  const values = new Set(conditions.filter((c) => c.building_block_id === statusQuestion?.id).flatMap((c) => c.values ?? []));
  return new Set((statusQuestion?.options ?? []).filter((o) => o.visible && values.has(o.value)).map((o) => o.label));
}

function ruleProblem(title, question, statusQuestion) {
  if (conditionsOf(question).some((c) => c.building_block_id !== statusQuestion?.id)) {
    return `"${title}" has a rule on a question other than Status`;
  }
  const shown = shownForLabels(question, statusQuestion);
  const when = SHOWN_FOR[title];
  const actual = shown === null ? 'it is always shown' : `it is shown for ${[...shown].join(', ') || 'no visible status'}`;
  if (when === undefined) return shown === null ? null : `"${title}" should always be shown; ${actual}`;
  const expected = visibleLabels(statusQuestion).filter((label) => (label === PLEDGED) === (when === 'pledged'));
  const matches = shown !== null && expected.join() === [...shown].join();
  return matches ? null : `"${title}" should be shown for ${expected.join(', ')}; ${actual}`;
}

// Pure. `form` is the monday `form(formToken:)` result: { questions: [{ id, type, title, visible,
// required, showIfRules, options: [{ label, value, visible }] }], features: { requireLogin: {
// enabled } } }. Returns a list of problems; empty = OK.
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
    if (q && EXPECTED_TYPES[title] && q.type !== EXPECTED_TYPES[title]) {
      problems.push(`"${title}" is a ${q.type} question (${q.id}); expected ${EXPECTED_TYPES[title]}`);
    }
  }
  const status = visible.get('Status');
  if (status) {
    const offersPledged = visibleLabels(status).includes(PLEDGED);
    if (!offersPledged) problems.push(`Status should offer "${PLEDGED}"`);
    for (const title of Object.keys(EXPECTED_QUESTIONS)) {
      const q = visible.get(title);
      const problem = q ? ruleProblem(title, q, status) : null;
      if (problem) problems.push(problem);
    }
  }
  if (form.features?.requireLogin?.enabled !== true) {
    problems.push('Require login to monday.com is off: the form is public to anyone with the link');
  }
  return problems;
}
