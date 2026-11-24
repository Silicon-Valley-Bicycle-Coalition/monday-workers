import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXPECTED_QUESTIONS, EXPECTED_TYPES, checkForm, shownForLabels } from './donation-form.mjs';

const question = (title, extra = {}) => ({ id: `id_${title}`, type: 'ShortText', title, visible: true, required: false, showIfRules: { operator: 'OR', rules: [] }, ...extra });
// A show-if rule as monday returns it (read back 2026-11-24).
const rule = (values, questionId = 'status') => ({ operator: 'OR', rules: [{ operator: 'OR', conditions: [{ building_block_id: questionId, operator: 'OR', values }] }] });
const STATUS = {
  id: 'status',
  options: [
    { label: 'Received', value: '0', visible: true },
    { label: 'Failed', value: '2', visible: true },
    { label: 'Pending', value: '3', visible: true },
    { label: 'Lost', value: '4', visible: false },
    { label: 'Pledged', value: '7', visible: true },
  ],
};
const NOT_PLEDGED = ['0', '2', '3'];
const goodForm = () => {
  const form = {
    questions: [
      { id: 'page', type: 'PAGE_BLOCK', title: 'Page', visible: true, required: false },
      ...Object.entries(EXPECTED_QUESTIONS).map(([title, required]) => question(title, { required, ...(EXPECTED_TYPES[title] ? { type: EXPECTED_TYPES[title] } : {}) })),
      question('🔒 Funding Stream', { visible: false }),
    ],
    features: { requireLogin: { enabled: true } },
  };
  const named = (title) => form.questions.find((q) => q.title === title);
  Object.assign(named('Status'), structuredClone(STATUS));
  named('Pledge date').showIfRules = rule(['7']);
  for (const title of ['Date received', 'Payment Method', 'Check/Reference Number']) named(title).showIfRules = rule(NOT_PLEDGED);
  return form;
};

describe('checkForm', () => {
  it('passes the configured form, ignoring hidden questions and the page block', () => {
    assert.deepEqual(checkForm(goodForm()), []);
  });

  it('flags a newly visible question, including a 🔒 one', () => {
    const form = goodForm();
    form.questions.push(question('🔒 New Rollup'));
    form.questions.push(question('Brand New Column'));
    const problems = checkForm(form);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /unexpected visible question "🔒 New Rollup"/);
    assert.match(problems[1], /"Brand New Column"/);
  });

  it('flags an expected question that was hidden', () => {
    const form = goodForm();
    form.questions.find((q) => q.title === 'Donor').visible = false;
    assert.deepEqual(checkForm(form), ['expected question "Donor" is hidden or missing']);
  });

  it('flags a question that should be required but is not', () => {
    const form = goodForm();
    form.questions.find((q) => q.title === 'Status').required = false;
    assert.deepEqual(checkForm(form), ['"Status" should be required']);
  });

  it('flags Gift Type shown as free text instead of the Status pick list', () => {
    const form = goodForm();
    form.questions.find((q) => q.title === 'Gift Type').type = 'ShortText';
    assert.deepEqual(checkForm(form), ['"Gift Type" is a ShortText question (id_Gift Type); expected SingleSelect']);
  });

  it('flags a form that does not require login, or has no feature block', () => {
    const form = goodForm();
    form.features.requireLogin.enabled = false;
    assert.match(checkForm(form)[0], /Require login/);
    delete form.features;
    assert.match(checkForm(form)[0], /Require login/);
  });

  it('requires the Pledge date question', () => {
    const form = goodForm();
    form.questions = form.questions.filter((q) => q.title !== 'Pledge date');
    assert.deepEqual(checkForm(form), ['expected question "Pledge date" is hidden or missing']);
  });

  it('flags a conditional question whose rule was lost', () => {
    const form = goodForm();
    form.questions.find((q) => q.title === 'Date received').showIfRules = { operator: 'OR', rules: [] };
    assert.deepEqual(checkForm(form), ['"Date received" should be shown for Received, Failed, Pending; it is always shown']);
  });

  it('flags Pledge date shown for the wrong status', () => {
    const form = goodForm();
    form.questions.find((q) => q.title === 'Pledge date').showIfRules = rule(['0']);
    assert.deepEqual(checkForm(form), ['"Pledge date" should be shown for Pledged; it is shown for Received']);
  });

  it('flags a visible status that leaves Date received hidden', () => {
    const form = goodForm();
    form.questions.find((q) => q.title === 'Status').options.push({ label: 'Refunded', value: '17', visible: true });
    assert.ok(checkForm(form).some((p) => p.startsWith('"Date received" should be shown for Received, Failed, Pending, Refunded')));
  });

  it('flags Status without a visible Pledged option', () => {
    const form = goodForm();
    form.questions.find((q) => q.title === 'Status').options.find((o) => o.label === 'Pledged').visible = false;
    assert.ok(checkForm(form).includes('Status should offer "Pledged"'));
  });

  it('flags an unconditional question that gained a rule', () => {
    const form = goodForm();
    form.questions.find((q) => q.title === 'Donor').showIfRules = rule(['0']);
    assert.deepEqual(checkForm(form), ['"Donor" should always be shown; it is shown for Received']);
  });

  it('flags a rule that depends on a question other than Status', () => {
    const form = goodForm();
    form.questions.find((q) => q.title === 'Date received').showIfRules = rule(['1'], 'anonymous');
    assert.deepEqual(checkForm(form), ['"Date received" has a rule on a question other than Status']);
  });
});

describe('shownForLabels', () => {
  it('is null for a question with no rule', () => {
    assert.equal(shownForLabels(question('Donor'), STATUS), null);
    assert.equal(shownForLabels({ title: 'Donor' }, STATUS), null);
  });

  it('is the visible Status labels of every rule and condition', () => {
    const showIfRules = { operator: 'OR', rules: [...rule(['3', '4']).rules, ...rule(['0']).rules] };
    assert.deepEqual(shownForLabels({ title: 'x', showIfRules }, STATUS), new Set(['Received', 'Pending']));
  });
});
