import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LOCKED, HISTORY, bareTitle, markedTitle, sameTitle } from './column-titles.mjs';

describe('bareTitle', () => {
  it('drops a leading 🔒 or 📜 marker and the space after it', () => {
    assert.equal(bareTitle('🔒 Lifetime Giving'), 'Lifetime Giving');
    assert.equal(bareTitle('📜 Salesforce ID'), 'Salesforce ID');
  });
  it('accepts the emoji variation selector and extra whitespace a hand rename may add', () => {
    assert.equal(bareTitle('🔒️  Gift Count'), 'Gift Count');
  });
  it('leaves an unmarked title, or a marker anywhere but the start, unchanged', () => {
    assert.equal(bareTitle('Lifetime Giving'), 'Lifetime Giving');
    assert.equal(bareTitle('Lifetime Giving 🔒'), 'Lifetime Giving 🔒');
  });
  it('strips only one marker', () => {
    assert.equal(bareTitle('🔒 📜 Odd'), '📜 Odd');
  });
});

describe('markedTitle', () => {
  it('prefixes the marker, replacing any marker already there', () => {
    assert.equal(markedTitle('Lifetime Giving', LOCKED), '🔒 Lifetime Giving');
    assert.equal(markedTitle('📜 Gift Count', LOCKED), '🔒 Gift Count');
    assert.equal(markedTitle('🔒 Salesforce ID', HISTORY), '📜 Salesforce ID');
  });
});

describe('sameTitle', () => {
  it('matches a marked Monday title against the bare title code asks for', () => {
    assert.ok(sameTitle('🔒 Lifetime Giving', 'Lifetime Giving'));
    assert.ok(sameTitle('Lifetime Giving', '🔒 Lifetime Giving'));
    assert.ok(!sameTitle('🔒 Lifetime Giving', 'Gift Count'));
  });
});
