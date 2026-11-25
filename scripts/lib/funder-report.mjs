// The numbers in a VTA or SMCTA quarterly report, worked out from the Education Tracker, Event
// Registrations and the Post-Class Survey. Pure: scripts/funder-report.mjs reads and writes Monday.
//
// A wrong number costs more than a blank one, so anything missing or doubtful is left out of the totals
// and listed under "Check before using".

export function parseQuarter(text) {
  const match = /^(\d{4})-Q([1-4])$/.exec(text ?? '');
  if (match === null) throw new Error(`"${text}" is not a quarter such as 2026-Q4`);
  const [, year, q] = match;
  const first = (Number(q) - 1) * 3 + 1;
  const lastDay = new Date(Date.UTC(Number(year), first + 2, 0)).getUTCDate();
  const month = (n) => String(n).padStart(2, '0');
  return { label: `${year} Q${q}`, from: `${year}-${month(first)}-01`, to: `${year}-${month(first + 2)}-${lastDay}` };
}

// Overrides win, then the lists; a zip on none is another county. Null for no zip.
export function countyOf(zip, { overrides, lists }) {
  if (zip === '') return null;
  if (Object.hasOwn(overrides, zip)) return overrides[zip];
  return Object.entries(lists).find(([, zips]) => zips.includes(zip))?.[0] ?? 'Other';
}

const AGES = ['<17', '18-24', '25-34', '35-44', '45-54', '55-64', '65-84', '85+', 'Prefer not to state'];
const FREQUENCIES = ['Rarely or never', 'A few times a year', 'A few times a month', 'A few times a week', 'Daily'];
const INCOMES = ['Less than $24,999', '$25,000 to $49,999', '$50,000 to $74,999', '$75,000 to $99,999', '$100,000 to $124,999',
  '$125,000 to $149,999', '$150,000 to $199,999', '$200,000 or above', 'Prefer not to state'];
const NO_COMMENT = /^(n\/?a|none|no|nothing|-+|\.+)?\.?$/i;

const sum = (items, pick) => items.reduce((total, item) => total + (pick(item) ?? 0), 0);
const hours = (items) => Math.round(sum(items, (r) => r.studentHours) * 10) / 10;
const percent = (part, whole) => (whole === 0 ? null : Math.round((part / whole) * 100));
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
// Survey and class text goes into a Markdown page: one line, and no table or heading marks.
const plain = (text) => text.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();

export function buildReport({ funder, quarter, today, rows, registrations, survey, spanishDates, county, options }) {
  const gaps = [];
  const inQuarter = (date) => date !== '' && date >= quarter.from && date <= quarter.to;
  const skipped = (row) => options.skipStatuses.includes(row.status);

  const mine = rows.filter((row) => row.funder === funder.tracker && inQuarter(row.date)).sort((a, b) => a.date.localeCompare(b.date));
  const isClinic = (row) => options.clinicEvents.includes(row.event);
  const isClass = (row) => row.eventType.startsWith('Class') && !isClinic(row);
  // A class today may not be over.
  const held = mine.filter((row) => !skipped(row) && row.date < today);
  const classes = held.filter(isClass);
  const clinicRows = held.filter(isClinic);

  for (const row of held) {
    const named = /^\d{4}-\d{2}-\d{2}/.exec(row.name)?.[0];
    if (named !== undefined && named !== row.date) gaps.push(`${plain(row.name)}: its Date is ${row.date}. Counted by Date.`);
  }
  const complete = classes.filter((row) => [row.registered, row.checkedIn, row.noShows].every((n) => n !== null));
  for (const row of classes) if (!complete.includes(row)) gaps.push(`${row.date} ${plain(row.name)}: a number is missing on the Tracker, so it isn't in the attendance totals.`);
  for (const row of clinicRows) if (row.checkedIn === null) gaps.push(`${row.date} ${plain(row.name)}: no visitor count on the Tracker.`);

  const registered = sum(complete, (r) => r.registered);
  const checkedIn = sum(complete, (r) => r.checkedIn);
  const noShows = sum(complete, (r) => r.noShows);
  const attendance = {
    held: classes.length, counted: complete.length, registered, checkedIn, noShows, canceled: registered - checkedIn - noShows,
    rate: percent(checkedIn, registered), studentHours: hours(complete),
    canceledClasses: mine.filter((row) => skipped(row) && isClass(row)).length,
    upcoming: mine.filter((row) => !skipped(row) && isClass(row) && row.date >= today).length,
  };
  const clinics = { held: clinicRows.length, visitors: sum(clinicRows, (r) => r.checkedIn), studentHours: hours(clinicRows) };

  return {
    funder: funder.label, quarter: quarter.label, today, attendance, clinics,
    classes: classes.map(({ date, name, registered: r, checkedIn: c, noShows: n, studentHours: h }) => ({ date, name, registered: r, checkedIn: c, noShows: n, studentHours: h })),
    otherEvents: held.filter((row) => !isClass(row) && !isClinic(row)),
    counties: countyCounts(classes, registrations, county, options, gaps),
    survey: surveyCounts({ funder, inQuarter, rows, skipped, survey, spanishDates, checkedIn, countedDates: new Set(complete.map((r) => r.date)), gaps }),
    gaps,
  };
}

function countyCounts(classes, registrations, county, options, gaps) {
  for (const row of classes) if (row.eventItemIds.length === 0) gaps.push(`${row.date} ${plain(row.name)}: no CRM Event linked, so its people aren't in the county table.`);
  const events = new Set(classes.flatMap((row) => row.eventItemIds));
  const people = registrations.filter((r) => events.has(r.eventItemId)).map((r) => ({ ...r, county: county(r.zip) }));
  const placed = people.filter((p) => p.county !== null);
  const noZip = people.length - placed.length;
  if (noZip > 0) gaps.push(`${noZip} of ${people.length} registrants have no zip, so the county table leaves them out.`);
  const order = [...options.homeCounties, 'Other'];
  const rows = order
    .map((name) => placed.filter((p) => p.county === name))
    .map((group, i) => ({ county: order[i], registered: group.length, attended: group.filter((p) => p.attendance === 'Attended').length, share: percent(group.length, placed.length) }))
    .filter((r) => r.registered > 0);
  return { rows, noZip };
}

function surveyCounts({ funder, inQuarter, rows, skipped, survey, spanishDates, checkedIn, countedDates, gaps }) {
  const fundersOn = (date) => [...new Set(rows.filter((r) => r.date === date && r.funder !== '' && !skipped(r)).map((r) => r.funder))];
  const inRange = survey.filter((s) => inQuarter(s.date));

  // A blank Funder is placed by its class date, when only one funder had a class that day.
  const blank = inRange.filter((s) => s.funder === '');
  const placedByDate = blank.filter((s) => fundersOn(s.date).length === 1 && fundersOn(s.date)[0] === funder.tracker);
  const unplaced = blank.filter((s) => fundersOn(s.date).length !== 1);
  if (placedByDate.length > 0) gaps.push(`${count(placedByDate.length, 'survey response')} with no Funder counted here by class date. Set Funder on the survey board to settle it.`);
  if (unplaced.length > 0) gaps.push(`${count(unplaced.length, 'survey response')} with no Funder, and no single funder that day, left out.`);

  const named = inRange.filter((s) => s.funder === funder.survey);
  for (const date of [...new Set(named.map((s) => s.date))].sort()) {
    const others = fundersOn(date);
    if (others.length > 0 && !others.includes(funder.tracker)) {
      const n = named.filter((s) => s.date === date).length;
      gaps.push(`${count(n, 'survey response')} for ${date} marked ${funder.survey}, but the Tracker's class that day is ${others.join(', ')}. Counted here; check the Funder.`);
    }
  }
  const spanish = spanishDates.filter(inQuarter).length;
  if (spanish > 0) gaps.push(`${count(spanish, 'response')} on the Spanish survey board this quarter. They count here only if copied to the main survey board.`);

  const mine = [...named, ...placedByDate];
  // The rate compares like with like, or isn't given.
  const uncounted = mine.filter((s) => !countedDates.has(s.date)).length;
  if (uncounted > 0) gaps.push(`${count(uncounted, 'survey response')} for dates with no class in the attendance totals, so there is no response rate.`);
  const tally = (pick, order = null) => {
    const answers = mine.map(pick).filter((a) => a !== '');
    const labels = [...new Set(answers)];
    const rank = (label) => { const i = order.indexOf(label); return i === -1 ? order.length : i; };
    const size = (label) => answers.filter((a) => a === label).length;
    labels.sort((a, b) => (order === null ? size(b) - size(a) : rank(a) - rank(b)) || a.localeCompare(b));
    return labels.map((label) => ({ label, count: size(label), share: percent(size(label), answers.length) }));
  };
  const change = (pick) => {
    const totals = { Increase: 0, 'About the same': 0, Decrease: 0 };
    for (const s of mine) {
      const [before, after] = pick(s);
      if (before === null || after === null) continue;
      totals[after > before ? 'Increase' : after < before ? 'Decrease' : 'About the same']++;
    }
    return totals;
  };
  const step = (answer) => { const i = FREQUENCIES.indexOf(answer); return i === -1 ? null : i; };
  const score = (answer) => { const n = Number.parseInt(answer, 10); return Number.isNaN(n) ? null : n; };
  const average = (pick) => {
    const given = mine.map((s) => score(pick(s))).filter((n) => n !== null && n > 0);
    return given.length === 0 ? null : Math.round((sum(given, (n) => n) / given.length) * 10) / 10;
  };
  const quotes = (pick) => mine.filter((s) => s.permission.startsWith('Yes')).map((s) => plain(pick(s))).filter((text) => !NO_COMMENT.test(text));
  const income = (s) => s.income.replace(/\s*-\s*(?=\$)/, ' to ');

  return {
    responses: mine.length, rate: uncounted > 0 ? null : percent(mine.length, checkedIn),
    gender: tally((s) => s.gender), age: tally((s) => s.age, AGES), ethnicity: tally((s) => s.ethnicity), income: tally(income, INCOMES), language: tally((s) => s.language),
    frequencyBefore: tally((s) => s.frequencyBefore, FREQUENCIES), frequencyAfter: tally((s) => s.frequencyAfter, FREQUENCIES),
    frequencyChange: change((s) => [step(s.frequencyBefore), step(s.frequencyAfter)]),
    comfortChange: change((s) => [score(s.comfortBefore), score(s.comfortAfter)]),
    classRating: average((s) => s.classRating), instructorRating: average((s) => s.instructorRating),
    quotes: { liked: quotes((s) => s.liked), difference: quotes((s) => s.difference), wish: quotes((s) => s.wish) },
  };
}

export function renderReport(report, { quotes }) {
  const { attendance: a, clinics, counties, survey: s } = report;
  const pct = (n) => (n === null ? 'n/a' : `${n}%`);
  const cell = (n) => (n === null ? '' : String(n));
  const table = (head, body) => ['', `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...body.map((r) => `| ${r.join(' | ')} |`), ''];
  const shares = (title, list) => (list.length === 0 ? [] : [`**${title}**`, ...table(['Answer', 'People', 'Share'], list.map((x) => [plain(x.label), x.count, pct(x.share)]))]);
  const changes = (title, totals) => {
    const all = sum(Object.values(totals), (n) => n);
    return all === 0 ? [] : [`**${title}**`, ...table(['Change', 'People', 'Share'], Object.entries(totals).map(([label, n]) => [label, n, pct(percent(n, all))]))];
  };
  const said = (title, list) => (quotes && list.length > 0 ? [`**${title}**`, '', ...list.map((text) => `- “${text}”`), ''] : []);

  return [
    `# ${report.funder} ${report.quarter} report numbers`, '',
    `Classes held before ${report.today}. Written by a script; edits here are overwritten.`, '',
    '## Check before using', '',
    ...(report.gaps.length === 0 ? ['Nothing found.'] : report.gaps.map((g) => `- ${g}`)), '',
    '## Attendance',
    ...table(['Measure', 'Number'], [
      ['Classes held', a.held], ['Classes in these totals', a.counted], ['Registered (cancellations included)', a.registered], ['Checked in', a.checkedIn],
      ['No-shows', a.noShows], ['Canceled', a.canceled], ['Attendance rate (checked in ÷ registered)', pct(a.rate)], ['Student-hours', a.studentHours],
      ['Classes canceled', a.canceledClasses], ['Classes still to come', a.upcoming],
      ['Repair clinics held', clinics.held], ['Repair clinic visitors', clinics.visitors], ['Repair clinic student-hours', clinics.studentHours],
    ]),
    '## Classes',
    ...(report.classes.length === 0 ? ['', 'None held yet.', ''] : table(['Date', 'Class', 'Registered', 'Checked in', 'No-shows', 'Student-hours'],
      report.classes.map((c) => [c.date, plain(c.name), cell(c.registered), cell(c.checkedIn), cell(c.noShows), cell(c.studentHours)]))),
    ...(report.otherEvents.length === 0 ? [] : ['**Other events**', '', ...report.otherEvents.map((e) => `- ${e.date} ${plain(e.name)}`), '']),
    '## Home county of registrants',
    ...(counties.rows.length === 0 ? ['', 'No zips yet.', ''] : table(['County', 'Registered', 'Attended', 'Share of registrants with a zip'], counties.rows.map((c) => [c.county, c.registered, c.attended, pct(c.share)]))),
    '## Post-class survey', '',
    `${count(s.responses, 'response')} from ${a.checkedIn} attendees (${pct(s.rate)}). Class rating ${s.classRating ?? 'n/a'} of 5, instructors ${s.instructorRating ?? 'n/a'} of 5. Shares are of those who answered each question.`, '',
    ...changes('How often they ride, before to after', s.frequencyChange), ...changes('Comfort, before to after', s.comfortChange),
    ...shares('Riding before the class', s.frequencyBefore), ...shares('Riding planned after the class', s.frequencyAfter),
    ...shares('Gender', s.gender), ...shares('Age', s.age), ...shares('Race / ethnicity', s.ethnicity), ...shares('Household income', s.income), ...shares('Primary language', s.language),
    ...said('What they liked', s.quotes.liked), ...said('What difference it made', s.quotes.difference), ...said('What they wished were different', s.quotes.wish),
  ].join('\n');
}
