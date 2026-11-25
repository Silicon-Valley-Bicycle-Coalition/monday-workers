import { realName } from '../eventbrite/placeholder';

export interface NameParts {
  firstName: string | null;
  lastName: string | null;
}

// Latin script only, two letters or more: a name in another script may put the family name first, and
// a bare initial, "Rider," or an email address isn't something to greet a person by.
const PLAIN_WORD = /^\p{Script=Latin}[\p{Script=Latin}\p{M}'’-]+$/u;
const HONORIFIC = /^(mr|mrs|ms|mx|miss|dr|prof|rev)$/i;
// realName drops a whole-placeholder name; only a split can turn "Info Requested Rider" into "Info".
const PLACEHOLDER_PREFIX = /^info requested\b/i;

// The First and Last Name for a new People item. Eventbrite's own parts win; a missing last name is
// whatever follows the first in the full name. With neither part, the full name is split, and a part
// it doesn't settle stays blank for staff: a wrong name in a greeting is worse than none.
export function nameParts(who: { firstName?: unknown; lastName?: unknown; name?: unknown }): NameParts {
  const firstName = realName(who.firstName);
  const lastName = realName(who.lastName);
  const name = realName(who.name)?.replace(/\s+/g, ' ') ?? '';
  if (firstName === null && lastName === null) return splitName(name);
  if (firstName !== null && lastName === null && name.startsWith(`${firstName} `)) {
    return { firstName, lastName: realName(name.slice(firstName.length)) };
  }
  return { firstName, lastName };
}

function splitName(name: string): NameParts {
  const [first = '', last = '', ...more] = name.split(' ');
  if (!PLAIN_WORD.test(first) || HONORIFIC.test(first) || PLACEHOLDER_PREFIX.test(name)) return { firstName: null, lastName: null };
  // In a longer name the last name could start at any word, so only the first is taken.
  return { firstName: first, lastName: more.length === 0 && PLAIN_WORD.test(last) ? last : null };
}
