// Pure logic for bootstrap-gifts-from-artifacts.mjs — no filesystem or argv here, so the
// row-building, safety guards, and SQL rendering are unit-testable (scripts/
// bootstrap-gifts-lib.test.mjs) and the CLI wrapper stays a thin shell.

// Affiliation Person links must resolve to one of the People boards, not organizations or unknown boards.
const PEOPLE_BOARD_KEYS = new Set(['people-live', 'people-historical']);

// Turns salesforce-import run artifacts into structured gift rows, tracking which board
// ids the artifacts actually reference so the guards below can compare them to config.
export function buildGiftRows({ payloads, ledgerEntries, boards, now }) {
  const itemBySfId = new Map();
  const archivedSfIds = new Set();
  for (const e of ledgerEntries) {
    if (e.kind === 'success') itemBySfId.set(e.sfId, { board: e.board, itemId: e.itemId });
    if (e.kind === 'archive') archivedSfIds.add(e.sfId);
  }
  const boardIdByKey = Object.fromEntries(Object.entries(boards).map(([k, v]) => [k, String(v.boardId)]));

  const rows = [];
  const donationBoardIds = new Set();
  const ownerBoardIds = new Set();
  let skippedNoOwner = 0;
  let skippedActingFor = 0;
  for (const p of payloads) {
    if (p.board !== 'donations') continue;
    const donation = itemBySfId.get(p.sfId);
    if (!donation) continue;
    if (boardIdByKey[donation.board] !== undefined) donationBoardIds.add(boardIdByKey[donation.board]);
    const donorLink = (p.links ?? []).find((l) => l.column === 'Donor');
    const owner = donorLink ? itemBySfId.get(donorLink.targetSfIds[0]) : undefined;
    if (!owner) { skippedNoOwner++; continue; } // anonymous or excluded-owner gifts carry no rollup weight
    const ownerBoardId = String(boardIdByKey[owner.board]);
    ownerBoardIds.add(ownerBoardId);
    const actingForLink = (p.links ?? []).find((l) => l.column === 'Acting for');
    const actingFor = actingForLink ? itemBySfId.get(actingForLink.targetSfIds[0]) : undefined;
    if (actingForLink && !actingFor) skippedActingFor++; // affiliation missing from the ledger — row still emitted
    const c = p.columns;
    rows.push({
      mondayItemId: String(donation.itemId),
      ownerItemId: String(owner.itemId),
      ownerBoardId,
      amountCents: Math.round(Number(c['Amount'] || 0) * 100),
      giftDate: typeof c['Date'] === 'object' && c['Date'] !== null ? (c['Date'].date ?? '') : '',
      fiscalYear: Number(c['Fiscal Year Ending'] || 0),
      status: typeof c['Status'] === 'object' && c['Status'] !== null ? (c['Status'].label ?? '') : '',
      giftType: c['Gift Type'] || null,
      funraiseId: typeof c['Funraise ID'] === 'object' && c['Funraise ID'] !== null
        ? (c['Funraise ID'].text ?? null) : null,
      sfId: String(p.sfId),
      archivedAt: archivedSfIds.has(p.sfId) ? now : null,
      actingForItemId: actingFor ? String(actingFor.itemId) : null,
    });
  }
  return { rows, skippedNoOwner, skippedActingFor, donationBoardIds, ownerBoardIds };
}

// Turns salesforce-import's affiliation payloads (board: 'affiliations', name '<Person> @ <Org>',
// a `Person` link to the contact) into rows for the `affiliations` table (migration 0005):
// affiliation item -> the Person it belongs to, so Organizational Giving can be summed from D1.
// Mirrors buildGiftRows's ledger-resolution shape; each payload needs both its own ledger
// success entry (for affiliationItemId) and a resolvable Person link on a People board.
export function buildAffiliationRows({ payloads, ledgerEntries, boards }) {
  const itemBySfId = new Map();
  for (const e of ledgerEntries) {
    if (e.kind === 'success') itemBySfId.set(e.sfId, { board: e.board, itemId: e.itemId });
  }
  const boardIdByKey = Object.fromEntries(Object.entries(boards).map(([k, v]) => [k, String(v.boardId)]));

  const rows = [];
  let skippedNoPerson = 0;
  let skippedNotPerson = 0;
  for (const p of payloads) {
    if (p.board !== 'affiliations') continue;
    const affiliation = itemBySfId.get(p.sfId);
    if (!affiliation) continue;
    const personLink = (p.links ?? []).find((l) => l.column === 'Person');
    const person = personLink ? itemBySfId.get(personLink.targetSfIds[0]) : undefined;
    if (!person) { skippedNoPerson++; continue; }
    // Person must be on a People board and that board must be in boards.json
    if (!PEOPLE_BOARD_KEYS.has(person.board) || boardIdByKey[person.board] === undefined) {
      skippedNotPerson++;
      continue;
    }
    rows.push({
      affiliationItemId: String(affiliation.itemId),
      personItemId: String(person.itemId),
      personBoardId: String(boardIdByKey[person.board]),
      name: String(p.name),
    });
  }
  return { rows, skippedNoPerson, skippedNotPerson };
}

// Refuse-to-run guards (each overridable only with an explicit --force):
// - 0 gift rows: the on-disk artifacts are stale/superseded — running anyway would
//   swap the authoritative ~37k-row ledger for nothing.
// - board ids outside config: the artifacts belong to a different board generation
//   than the one this Worker is configured against.
// - skippedNotPerson > 0: an affiliation Person is not on a People board.
// - 0 affiliation rows: same stale-artifact reasoning as 0 gift rows, for the affiliations table.
// - skippedNoPerson > 0: an affiliation's Person sfId doesn't resolve to a migrated item, so
//   that affiliation's attributed gifts would land on nobody's Organizational Giving.
// Returns a list of human-readable refusal reasons; empty means safe to proceed.
export function checkArtifactGuards({
  rows, skippedActingFor, donationBoardIds, ownerBoardIds, config,
  skippedNotPerson = 0, affiliationRows = [], skippedNoPerson = 0,
}) {
  const errors = [];
  if (rows.length === 0) {
    errors.push(
      'artifacts produced 0 gift rows — bootstrapping would replace the entire gifts ledger with nothing. ' +
      'These artifacts are likely from a superseded board generation; refusing to run.');
  }
  if (skippedActingFor > 0) {
    errors.push(
      `${skippedActingFor} gift(s) reference an "Acting for" affiliation the ledger lacks — ` +
      'bootstrapping would silently drop that attribution. Refusing to run.');
  }
  if (skippedNotPerson > 0) {
    errors.push(
      `${skippedNotPerson} affiliation(s) link a Person that is not on a People board (an Organization, or a board missing from boards.json) — refusing to run.`);
  }
  if (affiliationRows.length === 0) {
    errors.push(
      'artifacts produced 0 affiliation rows — bootstrapping would replace the entire affiliations table with nothing. ' +
      'These artifacts are likely from a superseded board generation; refusing to run.');
  }
  if (skippedNoPerson > 0) {
    errors.push(
      `${skippedNoPerson} affiliation(s) have a Person link that does not resolve to a migrated item — their attributed gifts would reach no one's Organizational Giving; refusing to run.`);
  }
  const configuredDonationBoards = [...new Set(config.donationRollups.donationBoards.map((b) => String(b.boardId)))];
  const configuredOwnerBoards = Object.keys(config.donationRollups.ownerColumnsByBoard);
  const unknownDonationBoards = [...donationBoardIds].filter((id) => !configuredDonationBoards.includes(id));
  const unknownOwnerBoards = [...ownerBoardIds].filter((id) => !configuredOwnerBoards.includes(id));
  if (unknownDonationBoards.length > 0) {
    errors.push(
      `artifact donation board id(s) [${unknownDonationBoards.join(', ')}] are not in the configured ` +
      `donationBoards [${configuredDonationBoards.join(', ')}] — artifacts from a superseded board generation; refusing to run.`);
  }
  if (unknownOwnerBoards.length > 0) {
    errors.push(
      `artifact owner board id(s) [${unknownOwnerBoards.join(', ')}] are not in the configured ` +
      `ownerColumnsByBoard [${configuredOwnerBoards.join(', ')}] — artifacts from a superseded board generation; refusing to run.`);
  }
  return errors;
}

const GIFT_COLUMNS = 'monday_item_id, owner_item_id, owner_board_id, amount_cents, gift_date,' +
  ' fiscal_year, status, gift_type, funraise_id, sf_id, archived_at, acting_for_item_id, source, updated_at';

// Staged swap instead of a bare DELETE-then-INSERT: every artifact row lands in a staging
// table first, and `gifts` itself is only touched by the final swap once all inserts have
// succeeded — a mid-run failure leaves the real ledger intact. (Remote
// `wrangler d1 execute --file` additionally imports atomically server-side: "if the
// execution fails to complete, your DB will return to its original state".)
export function renderSql(rows, now) {
  const esc = (s) => String(s).replace(/'/g, "''");
  const tuple = (r) =>
    `('${esc(r.mondayItemId)}','${esc(r.ownerItemId)}','${esc(r.ownerBoardId)}',` +
    `${r.amountCents},'${esc(r.giftDate)}',${r.fiscalYear},'${esc(r.status)}',` +
    `${r.giftType === null ? 'NULL' : `'${esc(r.giftType)}'`},` +
    `${r.funraiseId === null ? 'NULL' : `'${esc(r.funraiseId)}'`},'${esc(r.sfId)}',` +
    `${r.archivedAt === null ? 'NULL' : `'${esc(r.archivedAt)}'`},` +
    `${r.actingForItemId === null ? 'NULL' : `'${esc(r.actingForItemId)}'`},'import','${esc(now)}')`;

  const lines = [
    'DROP TABLE IF EXISTS gifts_bootstrap;',
    'CREATE TABLE gifts_bootstrap AS SELECT * FROM gifts LIMIT 0;',
  ];
  for (let i = 0; i < rows.length; i += 400) {
    lines.push(
      `INSERT INTO gifts_bootstrap (${GIFT_COLUMNS}) VALUES\n` +
      rows.slice(i, i + 400).map(tuple).join(',\n') + ';');
  }
  lines.push(
    '-- Swap: only reached after every staging insert above succeeded.',
    'DELETE FROM gifts;',
    `INSERT INTO gifts (${GIFT_COLUMNS}) SELECT ${GIFT_COLUMNS} FROM gifts_bootstrap;`,
    'DROP TABLE gifts_bootstrap;');
  return lines.join('\n') + '\n';
}

const AFFILIATION_COLUMNS = 'affiliation_item_id, person_item_id, person_board_id, name, updated_at';

// Same staged-swap pattern as renderSql, into the `affiliations` table (migration 0005).
export function renderAffiliationsSql(rows, now) {
  const esc = (s) => String(s).replace(/'/g, "''");
  const tuple = (r) =>
    `('${esc(r.affiliationItemId)}','${esc(r.personItemId)}','${esc(r.personBoardId)}',` +
    `'${esc(r.name)}','${esc(now)}')`;

  const lines = [
    'DROP TABLE IF EXISTS affiliations_bootstrap;',
    'CREATE TABLE affiliations_bootstrap AS SELECT * FROM affiliations LIMIT 0;',
  ];
  for (let i = 0; i < rows.length; i += 400) {
    lines.push(
      `INSERT INTO affiliations_bootstrap (${AFFILIATION_COLUMNS}) VALUES\n` +
      rows.slice(i, i + 400).map(tuple).join(',\n') + ';');
  }
  lines.push(
    '-- Swap: only reached after every staging insert above succeeded.',
    'DELETE FROM affiliations;',
    `INSERT INTO affiliations (${AFFILIATION_COLUMNS}) SELECT ${AFFILIATION_COLUMNS} FROM affiliations_bootstrap;`,
    'DROP TABLE affiliations_bootstrap;');
  return lines.join('\n') + '\n';
}
