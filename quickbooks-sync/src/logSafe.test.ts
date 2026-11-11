import { describe, expect, it } from 'vitest';
import { errorClass } from './logSafe';

describe('errorClass', () => {
  it('names the class and status/code, never the message', () => {
    const err = Object.assign(new Error('Duplicate Name: "Jane Doe" jane@example.com'), { name: 'MondayApiError', httpStatus: 400, code: 'ColumnValueException' });
    expect(errorClass(err)).toBe('MondayApiError HTTP 400 code ColumnValueException');
    expect(errorClass(new Error('secret'))).toBe('Error');
    expect(errorClass('jane@example.com')).toBe('string');
  });
});
