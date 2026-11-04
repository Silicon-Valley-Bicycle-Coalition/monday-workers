import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PARTNER_TYPES, proposePartnerType } from './partner-type-rules.mjs';

const propose = (current, name = 'Acme Widgets', website = '') =>
  proposePartnerType({ name, current, website });

test('the vocabulary is the ten values staff approved', () => {
  assert.deepEqual(PARTNER_TYPES, [
    'Municipal', 'Corporation', 'Bike Shop', 'Bike Club', 'Advocacy Group',
    'Foundation', 'Nonprofit', 'Press', 'Education', 'Other',
  ]);
});

test('every mapping #55 spells out is high confidence', () => {
  for (const [current, type] of [
    ['Individual or Family Foundation', 'Foundation'],
    ['Government Committee', 'Municipal'],
    ['Public Sector', 'Municipal'],
    ['School District', 'Education'],
    ['Community Based/Nonprofit', 'Nonprofit'],
    ['Outdoor Shop', 'Bike Shop'],
    ['BTWD Participant', 'Other'],
    ['Prospect', 'Other'],
  ]) {
    const name = type === 'Municipal' ? 'City of Fremont' : 'Acme Widgets';
    const got = propose(current, name);
    assert.equal(got.proposed, type, current);
    assert.equal(got.confidence, 'high', current);
  }
});

test('an approved value maps to itself, ignoring case', () => {
  assert.equal(propose('Advocacy group').proposed, 'Advocacy Group');
  assert.equal(propose('Advocacy group').confidence, 'high');
  assert.equal(propose('Bike Shop').proposed, 'Bike Shop');
});

test('a mapping #55 does not spell out is a judgment call, so medium', () => {
  const got = propose('Consulting Firm');
  assert.equal(got.proposed, 'Corporation');
  assert.equal(got.confidence, 'medium');
});

test('Municipal wins a combination, and the row says it was a combination', () => {
  const got = propose('Advocacy group;Government Committee;Bike Industry');
  assert.equal(got.proposed, 'Municipal');
  assert.equal(got.confidence, 'medium');
  assert.match(got.flags, /Combined value/);
});

test('combinations that agree on one type are not flagged', () => {
  const got = propose('Advocacy group;Advocacy Group');
  assert.equal(got.proposed, 'Advocacy Group');
  assert.equal(got.confidence, 'high');
  assert.equal(got.flags, '');
});

test('topic words do not vote against a real type', () => {
  const got = propose('Corporation;Health;Transportation');
  assert.equal(got.proposed, 'Corporation');
  assert.equal(got.confidence, 'high');
});

test('a topic word alone proposes nothing rather than guessing', () => {
  const got = propose('Transportation');
  assert.equal(got.proposed, '');
  assert.equal(got.confidence, 'none');
  assert.match(got.flags, /topic/i);
});

test('a topic word alone falls through to the name', () => {
  const got = propose('Transportation', 'City of Fremont');
  assert.equal(got.proposed, 'Municipal');
});

test('an unknown value is flagged, never silently mapped', () => {
  const got = propose('Moon Base');
  assert.equal(got.proposed, '');
  assert.match(got.flags, /Unmapped value: Moon Base/);
});

test('blank value with a government name proposes Municipal', () => {
  for (const name of [
    'City of Fremont', 'County of San Mateo BPAC', 'City & County of SF /Airport Commission',
    'California Department of Transportation (Caltrans)', 'San Jose Public Works',
    'Mountain View City Council', 'San Mateo County Board of Supervisors',
    "San Mateo County Sheriff's Office", 'Caltrain Joint Powers Board', 'San Mateo County',
  ]) {
    assert.equal(propose('', name).proposed, 'Municipal', name);
  }
});

test('a county in the name of a non-government group is not Municipal', () => {
  assert.equal(propose('', 'Fresno County Bicycle Coalition').proposed, 'Advocacy Group');
  assert.equal(propose('', 'San Mateo County Parks & Recreation Foundation').proposed, 'Foundation');
  assert.notEqual(propose('', 'Catholic Charities of Santa Clara County').proposed, 'Municipal');
  assert.notEqual(propose('', 'San Mateo County Event Center').proposed, 'Municipal');
  assert.notEqual(propose('', 'San Jose Sports Authority').proposed, 'Municipal');
});

test('schools and districts are Education', () => {
  for (const name of [
    'Cherry Chase Elementary School', 'Gilroy Unified School District',
    'Las Lomitas Elementary School District', 'SJSU School of Journalism',
    'Stanford, Graduate School of Business',
  ]) {
    assert.equal(propose('', name).proposed, 'Education', name);
  }
});

test('a name match alone is never high confidence', () => {
  const got = propose('', 'Fremont Cycles');
  assert.equal(got.proposed, 'Bike Shop');
  assert.notEqual(got.confidence, 'high');
  assert.match(got.basis, /name/i);
});

test('a .gov website is high confidence Municipal on an untyped org', () => {
  const got = propose('', 'Sunnyvale Traffic Office', 'https://www.sunnyvale.ca.gov/traffic');
  assert.equal(got.proposed, 'Municipal');
  assert.equal(got.confidence, 'high');
});

test('an .edu website is high confidence Education on an untyped org', () => {
  const got = propose('', 'Some Lab', 'http://lab.stanford.edu');
  assert.equal(got.proposed, 'Education');
  assert.equal(got.confidence, 'high');
});

test('a look-alike domain is not treated as government', () => {
  assert.notEqual(propose('', 'Sunnyvale Traffic', 'https://sunnyvale.gov.example.com').proposed, 'Municipal');
});

test('a person-shaped name proposes nothing and says why', () => {
  const got = propose('', 'Jane Smith');
  assert.equal(got.proposed, '');
  assert.match(got.flags, /person/i);
});

test('a two-word company is not mistaken for a person', () => {
  assert.doesNotMatch(propose('', 'Acme Consulting').flags, /person/i);
});

test('no signal at all proposes nothing', () => {
  const got = propose('', 'Zephyr');
  assert.equal(got.proposed, '');
  assert.equal(got.confidence, 'none');
});

test('an advocacy group named for a county or agency keeps its migrated type', () => {
  for (const name of ['Bike Santa Cruz County', 'Sustainable San Mateo County', 'Friends of Caltrain']) {
    const got = propose('Advocacy group;Transportation', name);
    assert.equal(got.proposed, 'Advocacy Group', name);
    assert.equal(got.flags, '', name);
  }
});

test('a friends-of group is not read as the agency it supports', () => {
  assert.equal(propose('', 'Friends of Caltrain').proposed, 'Nonprofit');
});

test('a k12 website means Education, not Municipal', () => {
  const got = propose('Other', 'San Mateo-Foster City School District', 'http://www.smfc.k12.ca.us/');
  assert.equal(got.proposed, 'Other');
  assert.doesNotMatch(got.flags, /Conflict/);
  assert.equal(propose('', 'Some Elementary', 'http://www.smfc.k12.ca.us/').proposed, 'Education');
});

test('a company with Foundation in its name is not a Foundation', () => {
  assert.equal(propose('', 'Foundation Technologies, Inc.').proposed, 'Corporation');
  assert.equal(propose('', 'Givinga Foundation, Inc.').proposed, 'Foundation');
});

test('any coalition reads as an Advocacy Group, even one with bikes in the name', () => {
  assert.equal(propose('', 'Bikes Belong Coalition').proposed, 'Advocacy Group');
  assert.equal(propose('', 'Auto-Free Bay Area Coalition').proposed, 'Advocacy Group');
});

test('a person-shaped name with a website is not flagged as a person', () => {
  assert.doesNotMatch(propose('', 'Levis Stadium', 'http://levisstadium.com/').flags, /person/i);
});

test('a couple is flagged as people', () => {
  for (const name of ['Alex and Sam Example', 'Jordan Q. Sample and Mei-Lin Placeholder']) {
    assert.match(propose('', name).flags, /person/i, name);
  }
});

test('a government label with no government name or website gets checked', () => {
  for (const name of ['KEEN Garage', 'Cupertino Chamber of Commerce']) {
    const got = propose('Public Sector', name);
    assert.equal(got.proposed, 'Municipal', name);
    assert.equal(got.confidence, 'medium', name);
    assert.match(got.flags, /no government signal/i, name);
  }
});

test('a government label backed by the website stays high confidence', () => {
  const got = propose('Public Sector', 'Silicon Valley Power', 'https://www.svpower.gov/');
  assert.equal(got.confidence, 'high');
  assert.equal(got.flags, '');
});

test('a Bike Industry value on a shop-shaped name is a Bike Shop', () => {
  const got = propose('Bike Industry', 'Volata Cycles');
  assert.equal(got.proposed, 'Bike Shop');
  assert.equal(got.confidence, 'medium');
});

test('a Bike Industry value on any other name stays Corporation', () => {
  assert.equal(propose('Bike Industry', 'Surly').proposed, 'Corporation');
});

test('a government name on a private-sector value is flagged for review', () => {
  const got = propose('Other Private Sector', 'City of Palo Alto');
  assert.equal(got.proposed, 'Municipal');
  assert.equal(got.confidence, 'medium');
  assert.match(got.flags, /conflict/i);
});
