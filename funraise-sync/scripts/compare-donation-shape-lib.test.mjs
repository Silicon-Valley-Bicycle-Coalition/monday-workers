import { it as test, expect } from 'vitest';
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
    expect(paths).toContain(p);
  }
  expect(paths).not.toContain('transaction.lastFour');
});

test('leaves flattens objects and keeps arrays whole', () => {
  expect([...leaves({ a: { b: 1, c: [1, 2] }, d: null }).keys()]).toEqual(['a.b', 'a.c', 'd']);
});

test('a matching record lines up, with numeric and string ids treated alike', () => {
  const w = { id: 42, description: 'Gift', supporter: { id: 7, email: 'x@example.org' }, transaction: { amount: 25, status: 'Complete' } };
  const a = { id: '42', description: 'Gift', supporter: { id: 7, email: 'x@example.org' }, transaction: { amount: 25, status: 'Complete' }, extra: 1 };
  const r = compareShapes(w, a, mappedPaths(funraiseSync));
  expect(r.linesUp).toBe(true);
  expect(r.other.map((o) => [o.path, o.verdict])).toEqual([['extra', 'only-in-api']]);
});

test('a differing amount or a path the API lacks does not line up', () => {
  const w = { id: 1, transaction: { amount: 25, status: 'Complete' } };
  const r = compareShapes(w, { id: 1, amount: 25, transaction: { amount: 30 } }, mappedPaths(funraiseSync));
  expect(r.linesUp).toBe(false);
  const v = Object.fromEntries(r.mapped.map((m) => [m.path, m.verdict]));
  expect(v['transaction.amount']).toBe('differs');
  expect(v['transaction.status']).toBe('missing-from-api');
});

test('formatRow prints no values', () => {
  const r = compareShapes({ supporter: { email: 'x@example.org' } }, { supporter: { email: 'y@example.org' } }, ['supporter.email']);
  expect(formatRow(r.mapped[0])).not.toContain('@');
});

test('byIdSql refuses a non-numeric id', () => {
  expect(() => byIdSql("1' OR 1=1")).toThrow();
  expect(byIdSql('123')).toMatch(/entity_id = '123'/);
});
