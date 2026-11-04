import { describe, it, expect } from 'vitest';
import { exactStaffMatcher, parseMondayUsers, staffMatcher } from './staff.js';

const CSV = `﻿Name,Email,Created At,Title,Has Photo,Location,Phone,Mobile Phone,Joined at,Birthday,User Status,User Type,Invited By,Teams,Products,Last active
Clarrissa Cabansagan,clarrissa@bikesiliconvalley.org,2024-11-05,,,,,,,,Activated,Admin,x,,wm,2026-08-23
Robin Doe,robin@bikesiliconvalley.org,2024-11-07,,,,,,,,Deactivated - No Access,Member,x,,wm,2025-10-11
deanna@bikesiliconvalley.org,deanna@bikesiliconvalley.org,2024-11-07,,,,,,,,Activated,Admin,x,,wm,2026-08-23
Gus Guest,gus@guest.example,2026-08-04,,,,,,,,Activated,Guest,x,,,2026-08-11
Billy,agent-151533@agent.monday.com,2026-06-30,,,,,,,,Activated,,x,,,Never logged in
`;

describe('parseMondayUsers', () => {
  it('keeps only activated Admin/Member humans, tolerating the BOM', () => {
    expect(parseMondayUsers(CSV)).toEqual([
      { name: 'Clarrissa Cabansagan', email: 'clarrissa@bikesiliconvalley.org' },
      { name: 'deanna@bikesiliconvalley.org', email: 'deanna@bikesiliconvalley.org' },
    ]);
  });
});

describe('staffMatcher', () => {
  const match = staffMatcher([
    { name: 'Clarrissa Cabansagan', email: 'clarrissa@bikesiliconvalley.org' },
    { name: 'deanna@bikesiliconvalley.org', email: 'deanna@bikesiliconvalley.org' },
    { name: 'Zachary Kearsley', email: 'zachary@bikesiliconvalley.org' },
  ]);

  it('matches exact names case-insensitively', () => {
    expect(match('Clarrissa Cabansagan')).toBe('clarrissa@bikesiliconvalley.org');
  });

  it('matches a unique first name against the email local part (name changes)', () => {
    expect(match('Deanna Chevas')).toBe('deanna@bikesiliconvalley.org');
  });

  it('returns null for former staff and ambiguous names', () => {
    expect(match('Seth Goddard')).toBeNull();
    expect(match('SVBC Integration')).toBeNull();
  });
});

describe('exactStaffMatcher', () => {
  const match = exactStaffMatcher([
    { name: 'Clarrissa Cabansagan', email: 'clarrissa@bikesiliconvalley.org' },
    { name: 'deanna@bikesiliconvalley.org', email: 'deanna@bikesiliconvalley.org' },
    { name: 'SVBC Integration', email: 'integration@bikesiliconvalley.org' },
    { name: 'Sam Lee', email: 'sam1@bikesiliconvalley.org' },
    { name: 'Sam Lee', email: 'sam2@bikesiliconvalley.org' },
  ]);

  it('matches exact names only, with no first-name fallback', () => {
    expect(match('clarrissa  CABANSAGAN')).toBe('clarrissa@bikesiliconvalley.org');
    expect(match('Deanna Chevas')).toBeNull();
  });

  it('never matches an integration user or an ambiguous name', () => {
    expect(match('SVBC Integration')).toBeNull();
    expect(match('Sam Lee')).toBeNull();
  });
});
