import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './check-donation-form.mjs';

const TOKEN = '567223ac739c23567e56e9057d81dbf5';

describe('parseArgs', () => {
  it('collects one or more form tokens', () => {
    assert.deepEqual(parseArgs(['--form', TOKEN]), { forms: [TOKEN] });
    assert.deepEqual(parseArgs(['--form', TOKEN, '--form', TOKEN.replace('5', '6')]).forms.length, 2);
  });
  it('rejects a missing, malformed or unknown argument', () => {
    assert.throws(() => parseArgs([]), /at least one --form/);
    assert.throws(() => parseArgs(['--form']), /needs a form token/);
    assert.throws(() => parseArgs(['--form', 'abc']), /32 hex/);
    assert.throws(() => parseArgs(['--board', '1']), /unknown argument/);
  });
});
