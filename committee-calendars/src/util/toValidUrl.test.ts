import { describe, it, expect } from 'vitest';
import { toValidUrl } from './toValidUrl';

describe('toValidUrl', () => {
  it('returns a valid http URL as-is', () => {
    expect(toValidUrl('http://example.com/meeting')).toBe('http://example.com/meeting');
  });

  it('returns a valid https URL as-is', () => {
    expect(toValidUrl('https://cupertino.legistar.com/MeetingDetail.aspx?LEGID=5259')).toBe(
      'https://cupertino.legistar.com/MeetingDetail.aspx?LEGID=5259'
    );
  });

  it('returns null for a relative path', () => {
    expect(toValidUrl('/calendar.aspx?EID=1234')).toBeNull();
  });

  it('returns null for a garbage string', () => {
    expect(toValidUrl('not a url at all')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(toValidUrl(null)).toBeNull();
  });
});
