// Proposes one of the ten approved Partner Type values for an Organizations item (GL#55), from its
// migrated free-text value, its website, and its name. Pure, and only ever a proposal: a person
// reviews the CSV that scripts/propose-partner-types.mjs builds from these before anything changes
// on Monday. When there is no real signal it proposes nothing, so "Other" keeps meaning a person
// decided that, not that a script gave up.
//
// Confidence:
//   high    the value is approved or GL#55 spells out its mapping, or the website is .gov / .edu
//   medium  a mapping GL#55 leaves to judgment, a combined value, or a government name
//   low     a pattern in the name
//   none    nothing proposed

export const PARTNER_TYPES = [
  'Municipal', 'Corporation', 'Bike Shop', 'Bike Club', 'Advocacy Group',
  'Foundation', 'Nonprofit', 'Press', 'Education', 'Other',
];

// A combined value resolves to whichever of its types comes first. Municipal leads because the
// Advocacy agency list and Stakeholder Type depend on it; Corporation and Other are the least
// specific, so they only win when nothing else is present.
const PRECEDENCE = [
  'Municipal', 'Bike Shop', 'Bike Club', 'Advocacy Group', 'Foundation',
  'Education', 'Press', 'Nonprofit', 'Corporation', 'Other',
];

const norm = (s) => s.trim().toLowerCase();

const SPELLED_OUT = new Map(Object.entries({
  ...Object.fromEntries(PARTNER_TYPES.map((t) => [norm(t), t])),
  'individual or family foundation': 'Foundation',
  'government committee': 'Municipal',
  'public sector': 'Municipal',
  'school district': 'Education',
  'community based/nonprofit': 'Nonprofit',
  'outdoor shop': 'Bike Shop',
  'btwd participant': 'Other',
  'prospect': 'Other',
}));

const JUDGMENT = new Map(Object.entries({
  'county district': 'Municipal',
  'community based organizations': 'Nonprofit',
  'neighborhood associations': 'Nonprofit',
  'service club': 'Nonprofit',
  'music/arts/culture': 'Nonprofit',
  'member organization': 'Nonprofit',
  'bike shop nonprofit': 'Bike Shop',
  'media': 'Press',
  ...Object.fromEntries([
    'private sector', 'other private sector', 'small local business', 'consulting firm',
    'engineering', 'engineering / planning', 'construction', 'construction/development',
    'legal', 'finance', 'banking', 'retail', 'technology', 'technology partner',
    'venture capital', 'biotechnology', 'manufacturing', 'apparel', 'hospitality',
    'healthcare', 'food & beverage', 'bike industry',
  ].map((v) => [v, 'Corporation'])),
}));

// What an organization works on rather than what it is. These never vote; alone, they leave the
// item to its website and name.
const TOPICS = new Set([
  'transportation', 'environment', 'environmental', 'health', 'housing', 'athletics',
  'event organizer',
]);

const GOVERNMENT_NAME = new RegExp(
  '\\b(city of|town of|county of|city & county|caltrans|public works|department of transportation' +
  '|city council|board of supervisors|sheriff|police department|fire department|bpac' +
  '|joint powers|transportation authority|transit authority|transit district|caltrain|samtrans' +
  '|vta|mtc|abag|baaqmd|sfmta|bart)\\b',
  'i',
);
const BARE_COUNTY = /^(?:[A-Z][a-z]+ ){1,3}County$/;
const SPECIAL_DISTRICT = /\b(water|sanitation|healthcare|fire|park|parks) district\b/i;

// Checked in order, after the non-government groups that often carry a place name.
const NAME_RULES = [
  ['Nonprofit', /\bfriends of\b/i],
  ['Advocacy Group', /\b(bicycle|bike|cycling|pedestrian|walk\w*) (advocates?|alliance)\b|\b(bike)?coalition\b|\bsafe routes\b/i],
  ['Foundation', /\bfoundation\b(?!\s+technolog)|\bcharitable\b/i],
  ['Education', /\b(school|university|college|academy|pta)\b/i],
];
const BIKE_SHOP_NAME = /\b(bike|bicycle) shop\b|\bcyclery\b|\b(bikes|bicycles|cycles)\b/i;
const LATER_NAME_RULES = [
  ['Bike Club', /\b(bike|bicycle|cycling|velo) club\b|\bwheelmen\b|\b(racing|cycling) team\b/i],
  ['Bike Shop', BIKE_SHOP_NAME],
  ['Press', /\b(newspaper|magazine|news|radio|television)\b/i],
  ['Corporation', /\b(inc|llc|llp|corp|corporation|ltd|company|bank|law offices?|consulting|engineering|restaurant|cafe|coffee|brewery|winery|hotel|realty|technologies|software)\b/i],
  ['Nonprofit', /\b(association|society|alliance|institute|church|rotary|kiwanis|ymca)\b/i],
];

// Two capitalized words (optional middle initial or suffix) and nothing that reads as a business.
// Loose on purpose: a false hit costs a reviewer one row.
const PERSON_NAME = /^[A-Z][a-zà-ÿ'’-]+(?:\s[A-Z]\.?)?\s[A-Z][a-zà-ÿ'’-]+(?:\s(?:Jr\.?|Sr\.?|II|III|IV))?$/;
const ORG_WORD = /\b(and|the|of|for|group|partners|associates|services|solutions|systems)\b/i;
const COUPLE = /^[A-Z][\w'’-]+(?:\s[A-Z]\.?)?(?:\s[A-Z][\w'’-]+)?\sand\s[A-Z][\w'’-]+(?:\s[A-Z]\.?)?\s[A-Z][\w'’-]+$/;

function hostOf(website) {
  const match = /[a-z][a-z0-9+.-]*:\/\/([^/\s:?#]+)/i.exec(website ?? '')
    ?? /^\s*(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(website ?? '');
  return match ? match[1].toLowerCase() : '';
}

function governmentSignal(name, website) {
  const host = hostOf(website);
  if (/\.gov$|\.ca\.us$/.test(host) && !isK12(host)) return { basis: `Website ${host}`, confidence: 'high' };
  if (isNonGovernmentGroup(name)) return null;
  if (GOVERNMENT_NAME.test(name)) {
    return { basis: 'Name reads as government', confidence: 'medium' };
  }
  return null;
}

const isK12 = (host) => /\.k12\./.test(host);
const isNonGovernmentGroup = (name) => NAME_RULES.some(([, re]) => re.test(name));

function fromCurrent(current) {
  const tokens = current.split(';').map((t) => t.trim()).filter(Boolean);
  const unknown = [];
  const topics = [];
  const types = new Set();
  let allSpelledOut = true;
  for (const token of tokens) {
    const key = norm(token);
    if (TOPICS.has(key)) topics.push(token);
    else if (SPELLED_OUT.has(key)) types.add(SPELLED_OUT.get(key));
    else if (JUDGMENT.has(key)) {
      types.add(JUDGMENT.get(key));
      allSpelledOut = false;
    } else unknown.push(token);
  }
  return { tokens, unknown, topics, types: [...types], allSpelledOut };
}

function fromSignals(name, website) {
  const host = hostOf(website);
  const government = governmentSignal(name, website);
  if (government) return { proposed: 'Municipal', ...government };
  if (host.endsWith('.edu') || isK12(host)) return { proposed: 'Education', confidence: 'high', basis: `Website ${host}` };
  for (const [type, re] of NAME_RULES) {
    if (re.test(name)) return { proposed: type, confidence: 'low', basis: 'Name pattern' };
  }
  // A bare "X County" is only safe on an untyped item: "Bike Santa Cruz County" has the same shape,
  // and its migrated value is what keeps it out of here.
  if (BARE_COUNTY.test(name)) {
    return { proposed: 'Municipal', confidence: 'medium', basis: 'Name reads as a county' };
  }
  if (SPECIAL_DISTRICT.test(name)) {
    return { proposed: 'Municipal', confidence: 'medium', basis: 'Name reads as a special district' };
  }
  for (const [type, re] of LATER_NAME_RULES) {
    if (re.test(name)) return { proposed: type, confidence: 'low', basis: 'Name pattern' };
  }
  return null;
}

const none = (basis, flags) => ({ proposed: '', confidence: 'none', basis, flags });

export function proposePartnerType({ name, current, website }) {
  const parsed = fromCurrent(current ?? '');
  const unmapped = parsed.unknown.length ? `Unmapped value: ${parsed.unknown.join('; ')}` : '';

  if (parsed.types.length) {
    const proposed = PRECEDENCE.find((t) => parsed.types.includes(t));
    const government = proposed === 'Municipal' ? null : governmentSignal(name, website);
    if (government) {
      return {
        proposed: 'Municipal',
        confidence: 'medium',
        basis: government.basis,
        flags: [`Conflict: migrated value maps to ${proposed}`, unmapped].filter(Boolean).join('. '),
      };
    }
    const combined = parsed.types.length > 1;
    const basis = `Migrated value: ${parsed.tokens.join('; ')}`;
    if (proposed === 'Corporation' && parsed.tokens.some((t) => norm(t) === 'bike industry') && BIKE_SHOP_NAME.test(name)) {
      return { proposed: 'Bike Shop', confidence: 'medium', basis: `${basis}, and the name reads as a shop`, flags: unmapped };
    }
    // Municipal is what Advocacy's agency list runs on, so a label alone doesn't get skimmed past:
    // Public Sector also covers chambers of commerce and at least one retailer.
    const unbacked = proposed === 'Municipal' && !governmentSignal(name, website);
    return {
      proposed,
      confidence: combined || !parsed.allSpelledOut || unmapped || unbacked ? 'medium' : 'high',
      basis,
      flags: [
        combined ? `Combined value: ${parsed.types.join(', ')}` : '',
        unbacked ? 'No government signal in name or website: check' : '',
        unmapped,
      ].filter(Boolean).join('. '),
    };
  }

  const signal = fromSignals(name, website);
  const topicNote = parsed.topics.length ? `Migrated value is a topic, not a type: ${parsed.topics.join('; ')}` : '';
  const flags = [topicNote, unmapped].filter(Boolean).join('. ');
  if (signal) return { ...signal, flags };
  if (flags) return none('No type signal', flags);
  const trimmed = name.trim();
  if (COUPLE.test(trimmed) || (!website && PERSON_NAME.test(trimmed) && !ORG_WORD.test(trimmed))) {
    return none('No type signal', 'Name may be a person: is this an organization?');
  }
  return none('No type signal', '');
}
