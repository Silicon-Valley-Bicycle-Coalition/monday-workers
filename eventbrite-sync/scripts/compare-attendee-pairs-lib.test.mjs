import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPair, indexAttendees, summarizeAttendee } from './compare-attendee-pairs-lib.mjs';

const att = (id, over = {}) => summarizeAttendee({ id, order_id: '900', status: 'Attending', ticket_class_name: 'Volunteer', created: '2025-10-01T00:00:00Z', ...over });

test('summarizeAttendee drops names and emails', () => {
  const s = summarizeAttendee({ id: 1, order_id: 2, profile: { name: 'A B', email: 'a@b.c' }, status: 'Attending' });
  assert.deepEqual(Object.keys(s).sort(), ['cancelled', 'changed', 'created', 'id', 'orderId', 'refunded', 'status', 'ticketClass']);
  assert.equal(s.orderId, '2');
});

test('same order is one order with two tickets', () => {
  assert.equal(classifyPair(att('1'), att('2')).verdict, 'SAME_ORDER');
});

test('two live orders is a real double registration', () => {
  assert.equal(classifyPair(att('1'), att('2', { order_id: '901' })).verdict, 'TWO_ORDERS_BOTH_LIVE');
});

test('a canceled first order is a re-registration', () => {
  assert.equal(classifyPair(att('1', { cancelled: true, status: 'Not Attending' }), att('2', { order_id: '901' })).verdict, 'TWO_ORDERS_ONE_DEAD');
});

test('refunded counts as dead', () => {
  assert.equal(classifyPair(att('1', { refunded: true }), att('2', { order_id: '901' })).verdict, 'TWO_ORDERS_ONE_DEAD');
});

test('both dead', () => {
  const dead = { cancelled: true, status: 'Not Attending' };
  assert.equal(classifyPair(att('1', dead), att('2', { ...dead, order_id: '901' })).verdict, 'TWO_ORDERS_BOTH_DEAD');
});

test('a missing attendee is reported, not guessed at', () => {
  assert.equal(classifyPair(att('1'), null).verdict, 'MISSING');
  assert.equal(classifyPair(null, null).verdict, 'MISSING');
});

test('missing order ids never count as the same order', () => {
  assert.notEqual(classifyPair(att('1', { order_id: null }), att('2', { order_id: null })).verdict, 'SAME_ORDER');
});

test('indexAttendees keys by string id', () => {
  assert.equal(indexAttendees([{ id: 5 }]).get('5').id, 5);
});
