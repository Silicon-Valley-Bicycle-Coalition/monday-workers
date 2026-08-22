import { describe, it, expect } from 'vitest';
import { renderTemplate } from './templates';

const data = { name: 'Jamie', memberUntil: '2026-10-01', renewalUrl: 'https://example.org/renew' };

describe('renderTemplate', () => {
  it('renders the 6-week stage', () => {
    const email = renderTemplate({ tag: '6w', offsetDays: 42 }, data);
    expect(email.subject).toMatch(/6 weeks/);
    expect(email.body).toContain('Jamie');
    expect(email.body).toContain('2026-10-01');
    expect(email.body).toContain('https://example.org/renew');
  });

  it('renders the 4-week stage', () => {
    const email = renderTemplate({ tag: '4w', offsetDays: 28 }, data);
    expect(email.subject).toMatch(/4 weeks/);
  });

  it('renders the 2-week stage', () => {
    const email = renderTemplate({ tag: '2w', offsetDays: 14 }, data);
    expect(email.subject).toMatch(/2 weeks/);
  });

  it('throws for an unknown stage tag', () => {
    expect(() => renderTemplate({ tag: '1w', offsetDays: 7 }, data)).toThrow(/1w/);
  });
});
