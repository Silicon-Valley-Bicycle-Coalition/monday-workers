import { describe, it, expect } from 'vitest';
import { parseJsonc } from './jsonc';

describe('parseJsonc', () => {
  it('parses plain JSON', () => {
    expect(parseJsonc('{"a": 1, "b": [true, null]}')).toEqual({ a: 1, b: [true, null] });
  });

  it('strips line and block comments outside strings', () => {
    expect(parseJsonc('{\n  // c\n  "a": 1, /* d */ "b": 2\n}')).toEqual({ a: 1, b: 2 });
  });

  it('keeps // inside strings, such as URLs', () => {
    expect(parseJsonc('{"u": "https://api.monday.com/v2" // trailing\n}')).toEqual({ u: 'https://api.monday.com/v2' });
  });

  it('keeps escaped quotes inside strings', () => {
    expect(parseJsonc('{"s": "say \\"hi\\" // not a comment"}')).toEqual({ s: 'say "hi" // not a comment' });
  });

  it('tolerates trailing commas', () => {
    expect(parseJsonc('{"a": [1, 2,], "b": {"c": 1,},}')).toEqual({ a: [1, 2], b: { c: 1 } });
  });

  it('lets a duplicated key resolve to its last value, as JSON.parse does', () => {
    expect(parseJsonc('{"a": 1, "a": 2}')).toEqual({ a: 2 });
  });
});
