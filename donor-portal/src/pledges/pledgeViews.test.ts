import { describe, it, expect } from 'vitest';
import { pledgesView, pledgesUnavailableView } from './pledgeViews';
import type { DonorPledges } from './loadPledgeData';

const section: DonorPledges = {
  donorItemId: 'donor-1',
  donorName: 'Jane',
  pledges: [
    { name: '2026 Annual Pledge', pledged: '$1,000.00', fulfilled: '$400.00', status: 'Active', dueDate: '2026-12-31', percentComplete: 40 },
    { name: 'Bike Fund', pledged: 'pending', fulfilled: '', status: 'New', dueDate: '', percentComplete: null },
  ],
};

describe('pledgesView', () => {
  it('renders each pledge row with its progress percent', () => {
    const html = pledgesView([section], 'en');
    expect(html).toContain('Jane');
    expect(html).toContain('2026 Annual Pledge');
    expect(html).toContain('$1,000.00');
    expect(html).toContain('40%');
    expect(html).toContain('2026-12-31');
  });

  it('renders a dash, not 0%, when progress is not computable', () => {
    const html = pledgesView([section], 'en');
    expect(html).toContain('—');
    expect(html).not.toContain('null');
  });

  it('shows the no-pledges message for a donor with none', () => {
    const html = pledgesView([{ donorItemId: 'donor-2', donorName: 'Sam', pledges: [] }], 'en');
    expect(html).toContain('No pledges are on file for Sam.');
    expect(html).not.toContain('<table>');
  });

  it('escapes Monday-sourced text', () => {
    const html = pledgesView(
      [
        {
          donorItemId: 'donor-1',
          donorName: '<script>alert(1)</script>',
          pledges: [{ name: '<b>x</b>', pledged: '"', fulfilled: "'", status: '<i>', dueDate: '&', percentComplete: null }],
        },
      ],
      'en'
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('pledgesUnavailableView', () => {
  it('renders the gated copy with a way back to the portal', () => {
    const html = pledgesUnavailableView('en');
    expect(html).toContain('Pledge tracking is not available yet');
    expect(html).toContain('/en/portal');
  });
});
