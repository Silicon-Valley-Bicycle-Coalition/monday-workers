import { describe, it, expect } from 'vitest';
import { renderDigest } from './render';

describe('renderDigest', () => {
  it('escapes cell values, links the view, and notes rows left out', () => {
    const r = renderDigest({
      subject: 's', intro: 'Intro', count: 1, viewUrl: 'https://x.monday.com/boards/1/views/2',
      sections: [
        { heading: 'Gifts', table: { headers: ['Donor'], rows: [['<b>Ann & Bo</b>']], more: 3 }, empty: 'None.' },
        { heading: 'Other', table: null, empty: 'Nothing here.' },
      ],
    }, 'https://logo');
    expect(r.html).toContain('&lt;b&gt;Ann &amp; Bo&lt;/b&gt;');
    expect(r.html).toContain('href="https://x.monday.com/boards/1/views/2"');
    expect(r.html).toContain('…and 3 more');
    expect(r.html).toContain('Nothing here.');
    expect(r.text).toContain('Donor: <b>Ann & Bo</b>');
    expect(r.text).toContain('Open the view in Monday: https://x.monday.com/boards/1/views/2');
  });
});
