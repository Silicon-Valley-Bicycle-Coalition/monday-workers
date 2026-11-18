// Eventbrite returns the literal text "Info Requested" for the name and email of some attendees, with
// no answers, while their order carries a real buyer. It isn't documented. 352 of 2026's 2,906 Pledge
// to Ride attendees are like this, so never treat either value as real.
const PLACEHOLDER = /^(info requested\s*)+$/i;

// One @, a dot in the domain, and none of the characters an unquoted address can't hold. Eventbrite
// also gives some attendees (canceled ones, and at least one still attending) a generated stand-in,
// "[xxxx-xxxxxxx-<digits>]-<digits>@…", that Monday's email column rejects as "email is not valid",
// failing the whole row write, Status and Ticket Type included (GL#115). Treated like a missing email.
const PLAIN_ADDRESS = /^[^\s@[\]()<>,;:"\\]+@[^\s@[\]()<>,;:"\\]+\.[^\s@[\]()<>,;:"\\]+$/;

export function realEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return PLAIN_ADDRESS.test(trimmed) ? trimmed : null;
}

export function realName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || PLACEHOLDER.test(trimmed) ? null : trimmed;
}

export function isPlaceholderAttendee(profile: { email?: string | null } | null | undefined): boolean {
  return typeof profile?.email === 'string' && PLACEHOLDER.test(profile.email.trim());
}
