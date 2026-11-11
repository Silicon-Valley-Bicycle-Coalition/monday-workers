import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXPECTED_QUESTIONS, checkForm } from './donation-form.mjs';

const question = (title, extra = {}) => ({ id: `id_${title}`, type: 'ShortText', title, visible: true, required: false, ...extra });
const goodForm = () => ({
  questions: [
    { id: 'page', type: 'PAGE_BLOCK', title: 'Page', visible: true, required: false },
    ...Object.entries(EXPECTED_QUESTIONS).map(([title, required]) => question(title, { required })),
    question('🔒 Funding Stream', { visible: false }),
  ],
  features: { requireLogin: { enabled: true } },
});

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

  it('flags a form that does not require login, or has no feature block', () => {
    const form = goodForm();
    form.features.requireLogin.enabled = false;
    assert.match(checkForm(form)[0], /Require login/);
    delete form.features;
    assert.match(checkForm(form)[0], /Require login/);
  });
});
