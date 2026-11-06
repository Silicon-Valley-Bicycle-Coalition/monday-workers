import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDFALL_TITLES,
  FORBIDDEN_USERS,
  scrubProfile,
  normalize,
  toWrite,
  valueToWrite,
  planItems,
  reconcile,
  isClean,
  formatReport,
  mentionsRemovedFlag,
  peopleStillFlagged,
  boardRowsFlagged,
} from './windfall-board.mjs';

describe('constants', () => {
  it('lists the 11 columns and the two forbidden users', () => {
    assert.equal(WINDFALL_TITLES.length, 11);
    assert.deepEqual(FORBIDDEN_USERS, ['120827741', '117112617']);
  });
});

describe('scrubProfile', () => {
  it('removes both flags and keeps the others in order', () =>
    assert.equal(
      scrubProfile('Job Level: VP\nFlags: Recent Mover, Recently Divorced, Boat Owner, Recent Death in Family'),
      'Job Level: VP\nFlags: Recent Mover, Boat Owner',
    ));
  it('drops the Flags line when nothing is left', () =>
    assert.equal(scrubProfile('Job Level: VP\nFlags: Recently Divorced'), 'Job Level: VP'));
  it('handles a hand edit: case and spacing', () =>
    assert.equal(scrubProfile('flags:  recently divorced ,Recent Mover'), 'Flags: Recent Mover'));
  it('leaves other lines alone', () =>
    assert.equal(scrubProfile('Note: Recently Divorced'), 'Note: Recently Divorced'));
  it('keeps longer flags that only contain a removed name', () =>
    assert.equal(scrubProfile('Flags: Not Recently Divorced Yet'), 'Flags: Not Recently Divorced Yet'));
  it('removes flags on CRLF profiles and keeps the line endings', () => {
    assert.equal(
      scrubProfile('A: 1\r\nFlags: Recently Divorced, Boat Owner\r\nB: 2'),
      'A: 1\r\nFlags: Boat Owner\r\nB: 2',
    );
    assert.equal(scrubProfile('A: 1\r\nFlags: Recent Death in Family\r\nB: 2'), 'A: 1\r\nB: 2');
    assert.equal(scrubProfile('A: 1\r\nFlags: Recently Divorced'), 'A: 1');
  });
  it('drops a leading Flags line with its ending, and a profile of only flags becomes empty', () => {
    assert.equal(scrubProfile('Flags: Recently Divorced\nB: 2'), 'B: 2');
    assert.equal(scrubProfile('Flags: Recently Divorced'), '');
  });
  it('removes flags from a hand edit with a leading space or a space before the colon', () => {
    assert.equal(scrubProfile(' Flags: Recently Divorced'), '');
    assert.equal(scrubProfile('A: 1\nFlags : Recently Divorced'), 'A: 1');
    assert.equal(scrubProfile('  flags:Recently Divorced, X'), 'Flags: X');
    assert.equal(scrubProfile('A: 1\n\tFLAGS :  Boat Owner , Recent Death in Family'), 'A: 1\nFlags: Boat Owner');
    assert.equal(scrubProfile('Note: Recently Divorced'), 'Note: Recently Divorced');
    assert.equal(scrubProfile('Flagship: Recently Divorced'), 'Flagship: Recently Divorced');
  });
  it('removes a flag written with extra inner spacing', () =>
    assert.equal(scrubProfile('Flags: Recently   Divorced, Boat Owner'), 'Flags: Boat Owner'));
});

describe('normalize', () => {
  it('treats every empty form as empty', () => {
    for (const [t, v] of [
      ['text', null],
      ['text', '""'],
      ['checkbox', null],
      ['checkbox', '{"checked":false}'],
      ['long_text', '{"text":""}'],
      ['link', '{"url":"","text":""}'],
      ['date', null],
      ['numbers', '""'],
    ])
      assert.equal(normalize(t, v), '', `${t} ${v}`);
  });
  it('ignores changed_at', () =>
    assert.equal(
      normalize('date', '{"date":"2026-01-02","changed_at":"a"}'),
      normalize('date', '{"date":"2026-01-02","changed_at":"b"}'),
    ));
  it('compares numbers by value', () =>
    assert.equal(normalize('numbers', '"2500000.00"'), normalize('numbers', '"2500000"')));
  it('reads a checkbox checked as true or "true"', () =>
    assert.equal(
      normalize('checkbox', '{"checked":true,"changed_at":"a"}'),
      normalize('checkbox', '{"checked":"true"}'),
    ));
  it('compares a date with its time', () => {
    assert.notEqual(
      normalize('date', '{"date":"2026-01-02","time":null}'),
      normalize('date', '{"date":"2026-01-02","time":"10:00:00"}'),
    );
  });
  it('compares a link by url and by text', () => {
    const a = normalize('link', '{"url":"https://x.test/a","text":"A"}');
    assert.notEqual(a, normalize('link', '{"url":"https://x.test/b","text":"A"}'));
    assert.notEqual(a, normalize('link', '{"url":"https://x.test/a","text":"B"}'));
    assert.equal(a, normalize('link', '{"url":"https://x.test/a","text":"A","changed_at":"z"}'));
  });
  it('does not throw on malformed JSON, and a bad value is never empty or equal to a good one', () => {
    for (const t of ['text', 'numbers', 'checkbox', 'date', 'long_text', 'link', 'status']) {
      const bad = normalize(t, '{not json');
      assert.notEqual(bad, '', t);
      assert.notEqual(bad, normalize(t, '"x"'), t);
    }
    assert.equal(normalize('text', '{not json'), normalize('text', '{not json'));
    assert.notEqual(normalize('text', '{not json'), normalize('text', '{not jsom'));
  });
  it('does not read an unexpected object or array shape as empty', () => {
    for (const [t, v] of [
      ['long_text', '{"foo":"bar"}'],
      ['long_text', '["x"]'],
      ['link', '{"foo":"bar"}'],
      ['link', '{"href":"https://a"}'],
      ['checkbox', '{"foo":"bar"}'],
      ['date', '{"foo":"bar"}'],
      ['checkbox', '["x"]'],
      ['date', '["x"]'],
      ['link', '["x"]'],
      ['long_text', '{"text":"hi","foo":"bar"}'],
    ]) {
      assert.notEqual(normalize(t, v), '', `${t} ${v}`);
      assert.match(normalize(t, v), /^raw:/, `${t} ${v}`);
    }
  });
  it('still reads the listed empties, with changed_at, as empty', () => {
    for (const [t, v] of [
      ['checkbox', '{"checked":false,"changed_at":"a"}'],
      ['long_text', '{"text":"","changed_at":"a"}'],
      ['link', '{"url":"","text":"","changed_at":"a"}'],
      ['date', '{"date":null,"time":null,"changed_at":"a"}'],
      ['long_text', '{}'],
    ])
      assert.equal(normalize(t, v), '', `${t} ${v}`);
  });
  it('does not call a person with an odd-shaped value and an empty board cell clean', () => {
    const people = [person('1', 'live', { 'Windfall Profile': cell('long_text', J({ foo: 'bar' })) })];
    const items = [boardRow('b1', ['1'], {})];
    const r = reconcile(people, items);
    assert.equal(isClean(r), false);
  });
  it('does not call a profile with a spaced Flags line clean on the board', () => {
    const v = cell('long_text', J({ text: ' Flags : Recently Divorced, Boat Owner' }));
    const people = [person('1', 'live', { 'Windfall Profile': v })];
    assert.equal(isClean(reconcile(people, [boardRow('b1', ['1'], { 'Windfall Profile': v })])), false);
    const scrubbed = cell('long_text', J({ text: 'Flags: Boat Owner' }));
    assert.equal(isClean(reconcile(people, [boardRow('b1', ['1'], { 'Windfall Profile': scrubbed })])), true);
  });
  it('compares an unknown type by raw text with changed_at removed', () => {
    assert.equal(
      normalize('status', '{"index":1,"changed_at":"a"}'),
      normalize('status', '{"changed_at":"b","index":1}'),
    );
    assert.notEqual(normalize('status', '{"index":1}'), normalize('status', '{"index":2}'));
  });
});

describe('toWrite', () => {
  it('shapes each type for Monday', () => {
    assert.equal(toWrite('text', '"CEO"'), 'CEO');
    assert.equal(toWrite('numbers', '"12.50"'), '12.50');
    assert.deepEqual(toWrite('checkbox', '{"checked":true,"changed_at":"a"}'), { checked: 'true' });
    assert.equal(toWrite('checkbox', '{"checked":false}'), null);
    assert.deepEqual(toWrite('date', '{"date":"2026-01-02","time":null,"changed_at":"a"}'), { date: '2026-01-02' });
    assert.deepEqual(toWrite('date', '{"date":"2026-01-02","time":"10:00:00"}'), {
      date: '2026-01-02',
      time: '10:00:00',
    });
    assert.deepEqual(toWrite('long_text', '{"text":"hi","changed_at":"a"}'), { text: 'hi' });
    assert.deepEqual(toWrite('link', '{"url":"https://x.test","text":"X","changed_at":"a"}'), {
      url: 'https://x.test',
      text: 'X',
    });
  });
  it('gives null for every empty form', () => {
    assert.equal(toWrite('text', null), null);
    assert.equal(toWrite('long_text', '{"text":""}'), null);
    assert.equal(toWrite('link', '{"url":"","text":""}'), null);
  });
  it('throws on a malformed value without quoting it', () => {
    assert.throws(() => toWrite('text', '{SECRET-BAD'), (e) => !/SECRET/.test(e.message));
  });
});

const cell = (type, value) => ({ type, value });
const J = (v) => JSON.stringify(v);
const person = (id, board, values) => ({ itemId: id, board, name: 'Fake Person', values });
const boardRow = (id, personIds, values) => ({ itemId: id, personIds, values });
const liveValues = () => ({
  'Windfall ID': cell('text', J('W-1')),
  'Net Worth': cell('numbers', J('2500000.00')),
  'Job Title': cell('text', J('CEO')),
  'Philanthropic Giver': cell('checkbox', J({ checked: true, changed_at: 'a' })),
  'Net Worth Date': cell('date', J({ date: '2026-01-02', time: null, changed_at: 'a' })),
  LinkedIn: cell('link', J({ url: 'https://x.test/p', text: 'p', changed_at: 'a' })),
  'Windfall Profile': cell('long_text', J({ text: 'Job Level: VP\nFlags: Recent Mover, Recently Divorced', changed_at: 'a' })),
});
const boardValues = () => ({
  'Windfall ID': cell('text', J('W-1')),
  'Net Worth': cell('numbers', J('2500000')),
  'Job Title': cell('text', J('CEO')),
  'Philanthropic Giver': cell('checkbox', J({ checked: 'true' })),
  'Net Worth Date': cell('date', J({ date: '2026-01-02', time: null })),
  LinkedIn: cell('link', J({ url: 'https://x.test/p', text: 'p' })),
  'Windfall Profile': cell('long_text', J({ text: 'Job Level: VP\nFlags: Recent Mover' })),
});
const histValues = () => ({ 'Job Title': cell('text', J('CFO')) });
const histBoard = () => ({ 'Job Title': cell('text', J('CFO')) });
const fixtures = () => ({
  people: [person('1', 'live', liveValues()), person('2', 'historical', histValues())],
  items: [boardRow('b1', ['1'], boardValues()), boardRow('b2', ['2'], histBoard())],
});

describe('planItems', () => {
  const p = (id, v) => person(id, 'live', { 'Job Title': cell('text', v) });
  it('includes anyone with any value, and skips people already linked', () => {
    assert.deepEqual(
      planItems([p('1', '"CEO"'), p('2', null), p('3', '"CFO"')], new Set(['3'])).map((r) => r.itemId),
      ['1'],
    );
  });
  it('skips a person whose profile holds only removed flags, keeps one with something left', () => {
    const only = person('1', 'live', { 'Windfall Profile': cell('long_text', J({ text: 'Flags: Recently Divorced' })) });
    const some = person('2', 'live', { 'Windfall Profile': cell('long_text', J({ text: 'Flags: Boat Owner, Recently Divorced' })) });
    assert.deepEqual(planItems([only, some], new Set()).map((r) => r.itemId), ['2']);
  });
  it('includes an itemId once when it appears twice', () => {
    assert.deepEqual(planItems([p('1', '"CEO"'), p('1', '"CEO"')], new Set()).map((r) => r.itemId), ['1']);
  });
  it('finds a value under a marked column title', () => {
    const marked = person('1', 'live', { '🔒 Job Title': cell('text', '"CEO"') });
    assert.equal(planItems([marked], new Set()).length, 1);
  });
});

describe('valueToWrite', () => {
  it('scrubs the profile, and writes others as they are', () => {
    assert.deepEqual(valueToWrite('Windfall Profile', liveValues()['Windfall Profile']), {
      text: 'Job Level: VP\nFlags: Recent Mover',
    });
    assert.equal(valueToWrite('Windfall Profile', cell('long_text', J({ text: 'Flags: Recently Divorced' }))), null);
    assert.equal(valueToWrite('Job Title', cell('text', J('CEO'))), 'CEO');
  });
});

describe('reconcile', () => {
  it('is clean when every value matches, including a profile that lost a flag', () => {
    const { people, items } = fixtures();
    const r = reconcile(people, items);
    assert.deepEqual(
      { ...r, perColumn: undefined },
      {
        people: 2,
        items: 2,
        missing: 0,
        extra: 0,
        duplicates: 0,
        mismatches: 0,
        perColumn: undefined,
        details: { missing: [], extra: [], duplicates: [], mismatches: [] },
      },
    );
    assert.equal(isClean(r), true);
    assert.deepEqual(r.perColumn['Windfall Profile'], { people: 1, board: 1 });
    assert.deepEqual(r.perColumn['Job Title'], { people: 2, board: 2 });
    assert.deepEqual(r.perColumn['Net Worth Low'], { people: 0, board: 0 });
  });
  it('counts a person with no board item as missing', () => {
    const { people, items } = fixtures();
    const r = reconcile(people, items.slice(0, 1));
    assert.equal(r.missing, 1);
    assert.equal(isClean(r), false);
  });
  it('counts two items linked to one person as duplicates', () => {
    const { people, items } = fixtures();
    const r = reconcile(people, [...items, boardRow('b3', ['1'], boardValues())]);
    assert.equal(r.duplicates, 1);
    assert.equal(r.extra, 0);
    assert.equal(isClean(r), false);
  });
  it('counts an item linked to nobody on People as extra', () => {
    const { people, items } = fixtures();
    const r = reconcile(people, [...items, boardRow('b3', ['999'], boardValues()), boardRow('b4', [], boardValues())]);
    assert.equal(r.extra, 2);
    assert.equal(isClean(r), false);
  });
  it('counts a differing value as a mismatch', () => {
    const { people, items } = fixtures();
    items[1].values['Job Title'] = cell('text', J('COO'));
    const r = reconcile(people, items);
    assert.equal(r.mismatches, 1);
    assert.equal(isClean(r), false);
  });
  it('counts a profile still holding a removed flag on the board as a mismatch', () => {
    const { people, items } = fixtures();
    items[0].values['Windfall Profile'] = liveValues()['Windfall Profile'];
    assert.equal(reconcile(people, items).mismatches, 1);
  });
  it('counts a value missing on the board, and a stray board value, as mismatches', () => {
    const a = fixtures();
    delete a.items[0].values['Job Title'];
    assert.equal(reconcile(a.people, a.items).mismatches, 1);
    const b = fixtures();
    b.items[1].values['Windfall ID'] = cell('text', J('W-9'));
    assert.equal(reconcile(b.people, b.items).mismatches, 1);
  });
  it('counts a malformed board value as a mismatch', () => {
    const { people, items } = fixtures();
    items[1].values['Job Title'] = cell('text', '{broken');
    assert.equal(reconcile(people, items).mismatches, 1);
  });
  it('does not mistake empty on both sides for a mismatch', () => {
    const { people, items } = fixtures();
    items[0].values['Net Worth Low'] = cell('numbers', null);
    items[0].values['LinkedIn'] = cell('link', J({ url: '', text: '' }));
    delete people[0].values.LinkedIn;
    const r = reconcile(people, items);
    assert.equal(r.mismatches, 0);
  });
  it('matches a profile that scrubs to empty with an empty board value', () => {
    const people = [
      person('1', 'live', {
        'Job Title': cell('text', J('CEO')),
        'Windfall Profile': cell('long_text', J({ text: 'Flags: Recently Divorced' })),
      }),
    ];
    const items = [boardRow('b1', ['1'], { 'Job Title': cell('text', J('CEO')) })];
    const r = reconcile(people, items);
    assert.equal(r.mismatches, 0);
    assert.deepEqual(r.perColumn['Windfall Profile'], { people: 0, board: 0 });
    assert.equal(isClean(r), true);
  });
  it('does not expect a person with no value on the board', () => {
    const people = [...fixtures().people, person('3', 'live', {})];
    const r = reconcile(people, fixtures().items);
    assert.equal(r.missing, 0);
    assert.equal(r.people, 3);
  });
  it('compares the row of a person with no value if one exists', () => {
    const people = [person('3', 'live', {})];
    const items = [boardRow('b3', ['3'], { 'Job Title': cell('text', J('CEO')) })];
    const r = reconcile(people, items);
    assert.equal(r.mismatches, 1);
    assert.equal(r.extra, 0);
  });
  it('counts each link of a board row with two personIds', () => {
    const people = [person('1', 'live', histValues()), person('2', 'live', histValues())];
    const r = reconcile(people, [boardRow('b1', ['1', '2'], histBoard())]);
    assert.equal(r.missing, 0);
    assert.equal(r.mismatches, 0);
    assert.equal(r.items, 1);
    const dup = reconcile(people, [boardRow('b1', ['1', '2'], histBoard()), boardRow('b2', ['1'], histBoard())]);
    assert.equal(dup.duplicates, 1);
  });
  it('matches a person moved between boards, since the key is itemId', () => {
    const { people, items } = fixtures();
    people[0].board = 'historical';
    assert.equal(isClean(reconcile(people, items)), true);
  });
  it('is not clean when the per-column counts disagree', () => {
    const r = reconcile([], []);
    r.perColumn['Job Title'] = { people: 2, board: 1 };
    assert.equal(isClean(r), false);
  });
  it('never returns or prints a value', () => {
    const people = [person('1', 'live', { 'Job Title': cell('text', J('SECRET-1')), 'Windfall ID': cell('text', J('SECRET-0')) })];
    const items = [boardRow('b1', ['1'], { 'Job Title': cell('text', J('SECRET-2')), 'Windfall ID': cell('text', J('SECRET-0')) })];
    const r = reconcile(people, items);
    assert.equal(r.mismatches, 1);
    assert.ok(!JSON.stringify(r).includes('SECRET'));
    assert.ok(!formatReport(r).includes('SECRET'));
    assert.ok(!formatReport(r).includes('Fake Person'));
  });
});

describe('reconcile details: where each problem is', () => {
  it('names the People item for a missing person', () => {
    const { people, items } = fixtures();
    assert.deepEqual(reconcile(people, items.slice(0, 1)).details.missing, ['2']);
  });
  it('names the board items for a duplicate', () => {
    const { people, items } = fixtures();
    const r = reconcile(people, [...items, boardRow('b3', ['1'], boardValues())]);
    assert.deepEqual(r.details.duplicates, [{ personId: '1', boardItemIds: ['b1', 'b3'] }]);
  });
  it('names the board item for an extra row, unlinked or linked to an unknown person', () => {
    const { people, items } = fixtures();
    const r = reconcile(people, [...items, boardRow('b3', ['999'], boardValues()), boardRow('b4', [], boardValues())]);
    assert.deepEqual(r.details.extra, ['b3', 'b4']);
  });
  it('names the People item, the board item and only the titles that differ', () => {
    const { people, items } = fixtures();
    items[1].values['Job Title'] = cell('text', J('COO'));
    items[1].values['Windfall ID'] = cell('text', J('W-9'));
    assert.deepEqual(reconcile(people, items).details.mismatches, [
      { personId: '2', boardItemIds: ['b2'], titles: ['Windfall ID', 'Job Title'] },
    ]);
  });
  it('lists only the differing row when a person has two rows', () => {
    const { people, items } = fixtures();
    const stale = boardValues();
    stale['Job Title'] = cell('text', J('COO'));
    const r = reconcile(people, [...items, boardRow('b3', ['1'], stale)]);
    assert.deepEqual(r.details.mismatches, [{ personId: '1', boardItemIds: ['b3'], titles: ['Job Title'] }]);
  });
  it('holds no value or name', () => {
    const people = [person('1', 'live', { 'Job Title': cell('text', J('SECRET-1')) })];
    const items = [boardRow('b1', ['1'], { 'Job Title': cell('text', J('SECRET-2')) })];
    const r = reconcile(people, items);
    assert.ok(!JSON.stringify(r).includes('SECRET'));
    assert.ok(!JSON.stringify(r).includes('Fake Person'));
  });
});

describe('the removed-flag check, independent of the scrubber', () => {
  const profile = (text) => ({ 'Windfall Profile': cell('long_text', J({ text })) });
  const missed = [
    'Flags: Boat Owner; Recently Divorced',
    'Flags - Recent Death in Family',
    'Life events: recently divorced',
    'Note: RECENT   DEATH IN\nFAMILY',
    'Recently\u00a0Divorced',
    'Flags: Not Recently Divorced Yet',
  ];
  it('finds a flag anywhere, in any spacing or case', () => {
    for (const text of missed) assert.equal(mentionsRemovedFlag(J({ text })), true, text);
    for (const text of missed) assert.equal(mentionsRemovedFlag(J(text)), true, text);
    assert.equal(mentionsRemovedFlag(J({ text: 'Flags: Boat Owner, Recent Mover' })), false);
    assert.equal(mentionsRemovedFlag(null), false);
    assert.equal(mentionsRemovedFlag(''), false);
  });
  it('reads malformed and odd-shaped values as text', () => {
    assert.equal(mentionsRemovedFlag('{broken Recently Divorced'), true);
    assert.equal(mentionsRemovedFlag(J({ text: 'x', note: 'Recently Divorced' })), true);
    assert.equal(mentionsRemovedFlag(J(['Recent Death in Family'])), true);
  });
  it('names People items still flagged after the scrub, and passes what the scrub cleared', () => {
    const people = missed.map((text, i) => person(String(i + 1), 'live', profile(text)));
    assert.deepEqual(peopleStillFlagged(people), people.map((p) => p.itemId));
    const clean = [
      person('1', 'live', profile('Flags: Recently Divorced, Boat Owner')),
      person('2', 'live', profile(' flags : recent death in family')),
      person('3', 'live', { 'Job Title': cell('text', J('CEO')) }),
    ];
    assert.deepEqual(peopleStillFlagged(clean), []);
  });
  it('finds a profile under a marked title and counts a repeated person once', () => {
    const marked = person('1', 'live', { '📜 Windfall Profile': cell('long_text', J({ text: 'x Recently Divorced' })) });
    assert.deepEqual(peopleStillFlagged([marked, marked]), ['1']);
  });
  it('looks only at the profile column', () => {
    assert.deepEqual(peopleStillFlagged([person('1', 'live', { 'Job Title': cell('text', J('Recently Divorced')) })]), []);
  });
  it('names board items whose profile holds a flag, unscrubbed', () => {
    const rows = [
      boardRow('b1', ['1'], profile('Flags: Recently Divorced')),
      boardRow('b2', ['2'], profile('Flags: Boat Owner')),
      boardRow('b3', ['3'], {}),
    ];
    assert.deepEqual(boardRowsFlagged(rows), ['b1']);
  });
});

describe('formatReport', () => {
  it('lists ids and titles for each problem, and no value or name', () => {
    const people = [
      person('1', 'live', { 'Job Title': cell('text', J('SECRET-1')) }),
      person('2', 'live', { 'Job Title': cell('text', J('SECRET-3')) }),
      person('3', 'live', { 'Job Title': cell('text', J('SECRET-4')) }),
    ];
    const items = [
      boardRow('b1', ['1'], { 'Job Title': cell('text', J('SECRET-2')) }),
      boardRow('b3', ['3'], { 'Job Title': cell('text', J('SECRET-4')) }),
      boardRow('b4', ['3'], { 'Job Title': cell('text', J('SECRET-4')) }),
      boardRow('b5', [], {}),
    ];
    const out = formatReport(reconcile(people, items));
    assert.match(out, /Missing: People item 2/);
    assert.match(out, /Mismatch: People item 1, board item b1: Job Title/);
    assert.match(out, /Duplicate: People item 3 on board items b3, b4/);
    assert.match(out, /Extra: board item b5/);
    assert.ok(!out.includes('SECRET'));
    assert.ok(!out.includes('Fake Person'));
  });
  it('lists nothing per id on a clean result', () => {
    const { people, items } = fixtures();
    assert.doesNotMatch(formatReport(reconcile(people, items)), /Missing: People|Mismatch:|Duplicate:|Extra: board/);
  });
  it('prints the counts and a verdict', () => {
    const { people, items } = fixtures();
    const out = formatReport(reconcile(people, items));
    assert.match(out, /People rows: 2/);
    assert.match(out, /Job Title: 2 \/ 2/);
    assert.match(out, /Result: clean/);
    assert.match(formatReport(reconcile(people, [])), /Missing: 2[\s\S]*NOT clean/);
  });
});
