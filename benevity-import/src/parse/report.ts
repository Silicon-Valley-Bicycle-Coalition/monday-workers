import { parseCsvLine } from './csv';
import { parseAmount } from '../util/money';
import { errorMessage } from '../util/errorMessage';

export interface ParsedRow {
  company: string;
  donorFirstName: string;
  donorLastName: string;
  email: string;
  donationDate: string; // ISO date (YYYY-MM-DD)
  transactionId: string;
  donationFrequency: string;
  currency: string;
  totalDonationToBeAcknowledged: number;
  matchAmount: number;
  // Comment/Reason/Source/Activity/Project/Project Remote ID, concatenated. Carried through for
  // a future Monday Updates post (spec: Input format) — not written anywhere by this Worker yet;
  // see the plan's Task 5 note and the README's open questions.
  notes: string;
}

export interface ParsedBlock {
  disbursementId: string;
  periodEnding: string; // ISO date
  currency: string;
  paymentMethod: string;
  charityName: string;
  rows: ParsedRow[];
  reportedGrossTotal: number;
  reportedNetTotal: number;
  sumMismatch: boolean;
  headerError: string | null;
}

const REQUIRED_HEADER_COLUMNS = [
  'Company',
  'Donor First Name',
  'Donor Last Name',
  'Email',
  'Donation Date',
  'Transaction ID',
  'Donation Frequency',
  'Currency',
  'Total Donation to be Acknowledged',
  'Match Amount',
] as const;

const NOTE_COLUMNS = ['Comment', 'Reason', 'Source', 'Activity', 'Project', 'Project Remote ID'];

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

export function parseBenevityReport(csvText: string): ParsedBlock[] {
  const lines = csvText.split(/\r\n|\n/).filter((line) => line.length > 0);
  const blockStarts: number[] = [];
  lines.forEach((line, i) => {
    if (/^Donations Report\b/i.test(line)) blockStarts.push(i);
  });
  if (blockStarts.length === 0) {
    throw new Error('report: no "Donations Report" block found in file');
  }

  return blockStarts.map((start, idx) => {
    const end = idx + 1 < blockStarts.length ? blockStarts[idx + 1] : lines.length;
    return parseBlock(lines.slice(start, end));
  });
}

function parseBlock(lines: string[]): ParsedBlock {
  try {
    return parseBlockOrThrow(lines);
  } catch (err) {
    return {
      disbursementId: '',
      periodEnding: '',
      currency: '',
      paymentMethod: '',
      charityName: '',
      rows: [],
      reportedGrossTotal: 0,
      reportedNetTotal: 0,
      sumMismatch: false,
      headerError: errorMessage(err),
    };
  }
}

function parseBlockOrThrow(lines: string[]): ParsedBlock {
  let i = 1; // lines[0] is "Donations Report,"
  if (!lines[i]?.startsWith('"#')) {
    throw new Error('report: expected a separator line after "Donations Report"');
  }
  i++;

  const preamble: Record<string, string> = {};
  while (i < lines.length && !lines[i].startsWith('"#')) {
    const [key, ...rest] = parseCsvLine(lines[i]);
    preamble[(key ?? '').trim()] = rest.join(',').trim();
    i++;
  }
  if (i >= lines.length) {
    throw new Error('report: preamble never closed with a separator line');
  }
  i++; // skip closing separator

  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) {
    throw new Error('report: no header row found');
  }
  const header = parseCsvLine(lines[i]);
  i++;
  for (const column of REQUIRED_HEADER_COLUMNS) {
    if (!header.includes(column)) {
      throw new Error(`report: header is missing required column "${column}"`);
    }
  }
  const colIndex = (name: string): number => header.indexOf(name);

  const rows: ParsedRow[] = [];
  while (i < lines.length && !/^totals\b/i.test(lines[i])) {
    const fields = parseCsvLine(lines[i]);
    const field = (name: string): string => (fields[colIndex(name)] ?? '').trim();
    rows.push({
      company: field('Company'),
      donorFirstName: field('Donor First Name'),
      donorLastName: field('Donor Last Name'),
      email: field('Email'),
      donationDate: parseDonationDate(field('Donation Date')),
      transactionId: field('Transaction ID'),
      donationFrequency: field('Donation Frequency'),
      currency: field('Currency'),
      totalDonationToBeAcknowledged: parseAmount(field('Total Donation to be Acknowledged')),
      matchAmount: parseAmount(field('Match Amount')),
      notes: buildNotes(fields, header),
    });
    i++;
  }

  let reportedGrossTotal = 0;
  let reportedNetTotal = 0;
  if (i < lines.length && /^totals\b/i.test(lines[i])) {
    i++;
    while (i < lines.length) {
      const [label, value] = parseCsvLine(lines[i]);
      if (/Total Donations \(Gross\)/i.test(label ?? '')) reportedGrossTotal = parseAmount(value ?? '');
      if (/Net Total Payment/i.test(label ?? '')) reportedNetTotal = parseAmount(value ?? '');
      i++;
    }
  }

  const rowsTotal = rows.reduce((sum, r) => sum + r.totalDonationToBeAcknowledged + r.matchAmount, 0);
  const sumMismatch = Math.abs(rowsTotal - reportedGrossTotal) > 0.01;

  if (!preamble['Disbursement ID']) {
    throw new Error('report: preamble missing "Disbursement ID"');
  }

  return {
    disbursementId: preamble['Disbursement ID'],
    periodEnding: parsePeriodEnding(preamble['Period Ending'] ?? ''),
    currency: preamble['Currency'] ?? '',
    paymentMethod: preamble['Payment Method'] ?? '',
    charityName: preamble['Charity Name'] ?? '',
    rows,
    reportedGrossTotal,
    reportedNetTotal,
    sumMismatch,
    headerError: null,
  };
}

function parseDonationDate(raw: string): string {
  // Row-level dates are full ISO datetimes ("2025-12-06T01:40:55Z"); Donations `Date` only
  // needs the calendar date.
  const isoDate = raw.slice(0, 10);
  if (Number.isNaN(Date.parse(isoDate))) {
    throw new Error(`report: "Donation Date" value "${raw}" is not a valid date`);
  }
  return isoDate;
}

function parsePeriodEnding(raw: string): string {
  // Benevity's preamble format, verified 2026-09-15: "Tue 16 Dec 2025 0:00:00"
  // (weekday name, day, three-letter month, 4-digit year, time — time discarded).
  const match = /^\w{3}\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\b/.exec(raw.trim());
  const month = match ? MONTHS[match[2]] : undefined;
  if (!match || !month) {
    throw new Error(`report: "Period Ending" value "${raw}" doesn't match the expected format`);
  }
  const day = match[1].padStart(2, '0');
  return `${match[3]}-${month}-${day}`;
}

function buildNotes(fields: string[], header: string[]): string {
  return NOTE_COLUMNS.map((col) => {
    const idx = header.indexOf(col);
    const value = idx === -1 ? '' : (fields[idx] ?? '').trim();
    return value === '' ? null : `${col}: ${value}`;
  })
    .filter((v): v is string => v !== null)
    .join('; ');
}
