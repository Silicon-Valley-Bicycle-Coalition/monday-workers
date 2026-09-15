import { describe, it, expect } from 'vitest';
import { parseCsvLine, parseCsvRows } from './csv';

describe('parseCsvLine', () => {
  it('splits a simple comma-separated line', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps a comma inside quotes as part of the field', () => {
    expect(parseCsvLine('"eBay, Inc.",Project,120.00')).toEqual(['eBay, Inc.', 'Project', '120.00']);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsvLine('"Say ""hi""",b')).toEqual(['Say "hi"', 'b']);
  });

  it('preserves an empty field between two commas', () => {
    expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });

  it('treats an empty quoted field as an empty string', () => {
    expect(parseCsvLine('a,"",c')).toEqual(['a', '', 'c']);
  });
});

describe('parseCsvRows', () => {
  it('splits multiple lines and skips blank ones', () => {
    expect(parseCsvRows('a,b\n\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsvRows('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});
