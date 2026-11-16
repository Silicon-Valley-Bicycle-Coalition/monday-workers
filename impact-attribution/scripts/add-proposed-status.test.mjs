import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultsJson, parseArgs, planColumn, verifyLabels } from './add-proposed-status.mjs';

test('planColumn finds an existing status column by bare title', () => {
  assert.deepEqual(planColumn([{ id: 'x', title: '🔒 Proposed status', type: 'status' }]), { action: 'exists' });
});

test('planColumn creates when absent', () => {
  assert.deepEqual(planColumn([{ id: 'st', title: 'Status', type: 'status' }]), { action: 'create' });
});

test('planColumn reports a same-titled column of another type instead of duplicating it', () => {
  assert.equal(planColumn([{ id: 'x', title: 'Proposed status', type: 'text' }]).action, 'conflict');
});

test('defaultsJson carries the two labels', () => {
  assert.deepEqual(JSON.parse(defaultsJson()), { labels: { 1: 'Current', 2: 'Former' } });
});

test('verifyLabels reports missing labels from settings_str', () => {
  const col = (labels) => [{ id: 'x', title: 'Proposed status', type: 'status', settings_str: JSON.stringify({ labels }) }];
  assert.deepEqual(verifyLabels(col({ 1: 'Current', 2: 'Former' })), []);
  assert.deepEqual(verifyLabels(col({ 5: 'Working on it' })), ['Proposed status is missing labels: Current, Former']);
  assert.deepEqual(verifyLabels([]), ['Proposed status column not found']);
});

test('parseArgs needs --env sandbox|production', () => {
  assert.deepEqual(parseArgs(['--env', 'sandbox']), { env: 'sandbox', execute: false });
  assert.deepEqual(parseArgs(['--env', 'production', '--execute']), { env: 'production', execute: true });
  assert.throws(() => parseArgs([]), /--env/);
  assert.throws(() => parseArgs(['--env', 'staging']), /--env/);
});
