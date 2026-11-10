import { describe, it, expect } from 'vitest';
import { planRegistrantsLinks } from './backfill-registrants-lib.mjs';

const reg = (itemId, eventItemId, registrantsLinked = false) => ({ itemId, eventItemId, registrantsLinked });

describe('planRegistrantsLinks', () => {
  it('links registrations that have an event and no link yet', () => {
    const plan = planRegistrantsLinks([reg('1', '100'), reg('2', '200')], []);
    expect(plan.toLink).toEqual([{ itemId: '1', eventItemId: '100' }, { itemId: '2', eventItemId: '200' }]);
  });

  it('skips linked ones, so a re-run resumes where the last stopped', () => {
    const plan = planRegistrantsLinks([reg('1', '100', true), reg('2', '100')], []);
    expect(plan.toLink).toEqual([{ itemId: '2', eventItemId: '100' }]);
    expect(plan.alreadyLinked).toBe(1);
  });

  it('leaves out excluded events and registrations with no event, and counts them', () => {
    const plan = planRegistrantsLinks([reg('1', '900'), reg('2', null), reg('3', '100')], ['900']);
    expect(plan.toLink).toEqual([{ itemId: '3', eventItemId: '100' }]);
    expect(plan.excluded).toBe(1);
    expect(plan.noEvent).toBe(1);
  });
});
