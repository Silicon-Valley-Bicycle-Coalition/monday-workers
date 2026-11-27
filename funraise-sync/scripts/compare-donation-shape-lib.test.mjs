import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mappedPaths, compareShapes, leaves, byIdSql, formatRow } from './compare-donation-shape-lib.mjs';

const funraiseSync = {
  columnMap: { 'transaction.amount': 'n', 'transaction.status': 's' },
  itemNameField: 'description',
  entityIdField: 'id',
  donorExternalIdField: 'supporter.id',
  emailFieldPrecedence: ['supporter.email'],
  doNotMigrateFields: ['transaction.lastFour'],
};

test('mappedPaths takes the config paths and the fixed consumer paths, not doNotMigrateFields', () => {
  const paths = mappedPaths(funraiseSync);
  for (const p of ['id', 'description', 'supporter.id', 'supporter.email', 'transaction.amount', 'donationDate', 'subscription.id']) {
    assert.ok(paths.includes(p), p);
  }
  assert.ok(!paths.includes('transaction.lastFour'));
});

test('leaves flattens objects and keeps arrays whole', () => {
  assert.deepEqual([...leaves({ a: { b: 1, c: [1, 2] }, d: null }).keys()], ['a.b', 'a.c', 'd']);
});

test('a matching record lines up, with numeric and string ids treated alike', () => {
  const w = { id: 42, description: 'Gift', supporter: { id: 7, email: 'x@example.org' }, transaction: { amount: 25, status: 'Complete' } };
  const a = { id: '42', description: 'Gift', supporter: { id: 7, email: 'x@example.org' }, transaction: { amount: 25, status: 'Complete' }, extra: 1 };
  const r = compareShapes(w, a, mappedPaths(funraiseSync));
  assert.equal(r.linesUp, true);
  assert.deepEqual(r.other.map((o) => [o.path, o.verdict]), [['extra', 'only-in-api']]);
});

test('a differing amount or a path the API lacks does not line up', () => {
  const w = { id: 1, transaction: { amount: 25, status: 'Complete' } };
  const r = compareShapes(w, { id: 1, amount: 25, transaction: { amount: 30 } }, mappedPaths(funraiseSync));
  assert.equal(r.linesUp, false);
  const v = Object.fromEntries(r.mapped.map((m) => [m.path, m.verdict]));
  assert.equal(v['transaction.amount'], 'differs');
  assert.equal(v['transaction.status'], 'missing-from-api');
});

test('formatRow prints no values', () => {
  const r = compareShapes({ supporter: { email: 'x@example.org' } }, { supporter: { email: 'y@example.org' } }, ['supporter.email']);
  assert.ok(!formatRow(r.mapped[0]).includes('@'));
});

test('byIdSql refuses a non-numeric id', () => {
  assert.throws(() => byIdSql("1' OR 1=1"));
  assert.match(byIdSql('123'), /entity_id = '123'/);
});
