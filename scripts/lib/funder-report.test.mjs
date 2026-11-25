import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, countyOf, parseQuarter, renderReport } from './funder-report.mjs';

const QUARTER = parseQuarter('2026-Q4');
const TODAY = '2026-11-24';
const FUNDER = { label: 'VTA', tracker: 'VTA', survey: 'VTA' };
const OPTIONS = { clinicEvents: ['Repair Clinic'], skipStatuses: ['Cancelled'], homeCounties: ['Santa Clara', 'San Mateo', 'SMC or SCC'] };

const row = (over = {}) => ({
  id: 'r1', name: 'Class', date: '2026-11-16', status: 'Done', funder: 'VTA', eventType: 'Class (presentation only)', event: 'Smart Cycling',
  registered: 11, checkedIn: 7, noShows: 3, studentHours: 17.5, eventItemIds: ['900'], ...over,
});
const answer = (over = {}) => ({
  funder: 'VTA', date: '2026-11-16', gender: 'Female', age: '25-34', ethnicity: 'Asian', income: '$50,000-$74,999', language: 'English',
  frequencyBefore: 'Rarely or never', frequencyAfter: 'Daily', comfortBefore: '2', comfortAfter: '5 - Very comfortable',
  classRating: '5', instructorRating: '4', permission: 'Yes, anonymously', liked: 'The maps', wish: '', difference: '', ...over,
});
const build = (over = {}) => buildReport({
  funder: FUNDER, quarter: QUARTER, today: TODAY, rows: [row()], registrations: [], survey: [], spanishDates: [], county: () => 'Santa Clara', options: OPTIONS, ...over,
});

describe('parseQuarter', () => {
  it('gives the calendar quarter’s days', () => {
    assert.deepEqual(parseQuarter('2026-Q4'), { label: '2026 Q4', from: '2026-10-01', to: '2026-12-31' });
    assert.deepEqual(parseQuarter('2027-Q2'), { label: '2027 Q2', from: '2027-04-01', to: '2027-06-30' });
  });

  it('refuses anything else', () => {
    for (const bad of ['2026-Q5', '2026Q4', 'Q4']) assert.throws(() => parseQuarter(bad), /quarter/);
  });
});

describe('countyOf', () => {
  const tables = { overrides: { 94303: 'SMC or SCC' }, lists: { 'San Mateo': ['94303', '94010'], 'Santa Clara': ['95112'] } };
  it('lets an override win, then the lists, and says Other for the rest', () => {
    assert.equal(countyOf('94303', tables), 'SMC or SCC');
    assert.equal(countyOf('95112', tables), 'Santa Clara');
    assert.equal(countyOf('94601', tables), 'Other');
  });
  it('has no county for a blank zip', () => assert.equal(countyOf('', tables), null));
});

describe('attendance', () => {
  it('adds up held classes, and the rate counts cancellations as registered', () => {
    const { attendance } = build({ rows: [row(), row({ id: 'r2', registered: 4, checkedIn: 2, noShows: 2, studentHours: 12 })] });
    assert.deepEqual(attendance, { held: 2, counted: 2, registered: 15, checkedIn: 9, noShows: 5, canceled: 1, rate: 60, studentHours: 29.5, canceledClasses: 0, upcoming: 0 });
  });

  it('leaves out other funders, other quarters, canceled classes and ones not yet held', () => {
    const { attendance } = build({ rows: [
      row(), row({ id: 'a', funder: 'SMC' }), row({ id: 'b', date: '2026-09-30' }), row({ id: 'c', date: '2027-01-01' }),
      row({ id: 'd', status: 'Cancelled' }), row({ id: 'e', date: TODAY }), row({ id: 'f', date: '2026-12-03' }),
    ] });
    assert.equal(attendance.held, 1);
    assert.equal(attendance.canceledClasses, 1);
    assert.equal(attendance.upcoming, 2);
  });

  it('counts a class missing a number as held but not in the totals, and says so', () => {
    const report = build({ rows: [row(), row({ id: 'r2', name: 'No numbers', registered: null })] });
    assert.equal(report.attendance.held, 2);
    assert.equal(report.attendance.counted, 1);
    assert.equal(report.attendance.registered, 11);
    assert.ok(report.gaps.some((g) => g.includes('No numbers')));
  });

  it('has no rate with nobody registered', () => {
    assert.equal(build({ rows: [] }).attendance.rate, null);
  });

  it('keeps clinics out of the class totals', () => {
    const report = build({ rows: [row(), row({ id: 'c', name: 'Clinic', event: 'Repair Clinic', registered: null, checkedIn: 36, noShows: null, studentHours: 72 })] });
    assert.equal(report.attendance.held, 1);
    assert.equal(report.attendance.studentHours, 17.5);
    assert.deepEqual(report.clinics, { held: 1, visitors: 36, studentHours: 72 });
    assert.deepEqual(report.gaps, []);
  });

  it('lists classes by date', () => {
    const { classes } = build({ rows: [row({ date: '2026-11-18' }), row({ id: 'b', date: '2026-10-01' }), row({ id: 'c', date: '2026-11-16' })] });
    assert.deepEqual(classes.map((c) => c.date), ['2026-10-01', '2026-11-16', '2026-11-18']);
  });

  it('flags a class whose name starts with a different date', () => {
    const report = build({ rows: [row({ name: '2027-11-16 Smart Cycling' }), row({ id: 'b', name: '2026-11-16 Fine' })] });
    assert.equal(report.gaps.filter((g) => g.includes('2027-11-16')).length, 1);
    assert.equal(report.gaps.length, 1);
  });

  it('lists other events apart', () => {
    const report = build({ rows: [row(), row({ id: 'o', name: 'LCI Seminar', eventType: 'Other Event', registered: null })] });
    assert.deepEqual(report.otherEvents.map((r) => r.name), ['LCI Seminar']);
    assert.equal(report.attendance.held, 1);
  });
});

describe('county', () => {
  const reg = (zip, attendance = 'Attended') => ({ eventItemId: '900', zip, attendance });
  const county = (zip) => countyOf(zip, { overrides: {}, lists: { 'Santa Clara': ['95112'], 'San Mateo': ['94010'] } });

  it('counts registrants and attendees by county, with shares of those who gave a zip', () => {
    const { counties } = build({ county, registrations: [reg('95112'), reg('95112', 'Canceled'), reg('94010', 'Registered'), reg('94601'), reg('')] });
    assert.deepEqual(counties.rows, [
      { county: 'Santa Clara', registered: 2, attended: 1, share: 50 },
      { county: 'San Mateo', registered: 1, attended: 0, share: 25 },
      { county: 'Other', registered: 1, attended: 1, share: 25 },
    ]);
    assert.equal(counties.noZip, 1);
  });

  it('ignores registrations for an event this funder’s held classes don’t link to', () => {
    assert.equal(build({ county, registrations: [{ eventItemId: '901', zip: '95112', attendance: 'Attended' }] }).counties.rows.length, 0);
  });

  it('warns about missing zips and unlinked classes', () => {
    const { gaps } = build({ county, rows: [row(), row({ id: 'u', name: 'Unlinked', eventItemIds: [] })], registrations: [reg(''), reg('95112')] });
    assert.ok(gaps.some((g) => g.includes('1 of 2') && g.includes('zip')));
    assert.ok(gaps.some((g) => g.includes('Unlinked')));
  });
});

describe('survey', () => {
  it('counts the funder’s responses in the quarter, and the response rate against attendees', () => {
    const { survey } = build({ survey: [answer(), answer(), answer({ funder: 'SMC' }), answer({ date: '2026-09-30' })], rows: [row()] });
    assert.equal(survey.responses, 2);
    assert.equal(survey.rate, 29);
  });

  it('works out the change from the before and after answers', () => {
    const { survey } = build({ survey: [
      answer(), answer({ frequencyAfter: 'Rarely or never', comfortAfter: '2' }),
      answer({ frequencyBefore: 'Daily', frequencyAfter: 'A few times a week', comfortBefore: '5 - Very comfortable', comfortAfter: '3' }),
      answer({ frequencyAfter: '', comfortBefore: '' }),
    ] });
    assert.deepEqual(survey.frequencyChange, { Increase: 1, 'About the same': 1, Decrease: 1 });
    assert.deepEqual(survey.comfortChange, { Increase: 1, 'About the same': 1, Decrease: 1 });
  });

  it('gives no response rate when responses come from classes the totals leave out, and says so', () => {
    const report = build({ survey: [answer(), answer({ date: '2026-10-20' })] });
    assert.equal(report.survey.responses, 2);
    assert.equal(report.survey.rate, null);
    assert.ok(report.gaps.some((g) => g.includes('1 survey response') && g.includes('response rate')));
  });

  it('places a response with no Funder by its class date, when only one funder had a class that day', () => {
    const report = build({ survey: [answer({ funder: '' })] });
    assert.equal(report.survey.responses, 1);
    assert.ok(report.gaps.some((g) => g.includes('no Funder')));
  });

  it('leaves out a response with no Funder when two funders had a class that day, and says so', () => {
    const report = build({ rows: [row(), row({ id: 's', funder: 'SMC' })], survey: [answer({ funder: '' })] });
    assert.equal(report.survey.responses, 0);
    assert.ok(report.gaps.some((g) => g.includes('no Funder')));
  });

  it('flags a response whose Funder had no class that day', () => {
    const report = build({ rows: [row({ funder: 'SMC' })], survey: [answer()] });
    assert.ok(report.gaps.some((g) => g.includes('2026-11-16') && g.includes('SMC')));
  });

  it('joins the two spellings of an income range', () => {
    const { survey } = build({ survey: [answer(), answer({ income: '$50,000 to $74,999' })] });
    assert.deepEqual(survey.income, [{ label: '$50,000 to $74,999', count: 2, share: 100 }]);
  });

  it('keeps ages and incomes in order, and other answers by count', () => {
    const { survey } = build({ survey: [answer({ age: '55-64' }), answer({ age: '55-64' }), answer({ age: '<17' }), answer({ ethnicity: 'White' }), answer({ ethnicity: 'White' }), answer({ ethnicity: 'White' })] });
    assert.deepEqual(survey.age.map((a) => a.label), ['<17', '25-34', '55-64']);
    assert.deepEqual(survey.ethnicity.map((a) => a.label), ['Asian', 'White']);
  });

  it('gives shares of those who answered the question', () => {
    const { survey } = build({ survey: [answer(), answer({ gender: 'Male' }), answer({ gender: '' })] });
    assert.deepEqual(survey.gender, [{ label: 'Female', count: 1, share: 50 }, { label: 'Male', count: 1, share: 50 }]);
  });

  it('averages the ratings given', () => {
    const { survey } = build({ survey: [answer(), answer({ classRating: '4', instructorRating: '' })] });
    assert.equal(survey.classRating, 4.5);
    assert.equal(survey.instructorRating, 4);
  });

  it('quotes only people who allowed it', () => {
    const { survey } = build({ survey: [answer(), answer({ permission: 'No', liked: 'Secret' }), answer({ permission: '', liked: 'Secret' }), answer({ liked: 'N/A' })] });
    assert.deepEqual(survey.quotes.liked, ['The maps']);
  });

  it('mentions Spanish-board responses in the quarter', () => {
    assert.ok(build({ spanishDates: ['2026-11-16', '2026-09-20'] }).gaps.some((g) => g.includes('1') && g.includes('Spanish')));
  });
});

describe('renderReport', () => {
  it('leads with what to check, and can leave quotes out', () => {
    const report = build({ rows: [row(), row({ id: 'r2', name: 'No numbers', registered: null })], survey: [answer()] });
    const text = renderReport(report, { quotes: true });
    assert.ok(text.indexOf('Check before using') < text.indexOf('Attendance'));
    assert.ok(text.includes('The maps'));
    assert.ok(!renderReport(report, { quotes: false }).includes('The maps'));
  });

  it('keeps a quote or class name from breaking the page', () => {
    const text = renderReport(build({ rows: [row({ name: 'A | B\nC' })], survey: [answer({ liked: 'One\n\n# Two | three' })] }), { quotes: true });
    assert.ok(!/^# Two/m.test(text));
    assert.ok(!text.includes('A | B'));
  });

  it('says n/a instead of a made-up rate', () => {
    assert.ok(renderReport(build({ rows: [] }), { quotes: true }).includes('n/a'));
  });
});
