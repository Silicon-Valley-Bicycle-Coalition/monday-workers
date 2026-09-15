import type { MondayClient } from '../monday/client';
import type { BenevityImportConfig } from '../types';

export type PersonResolution =
  | { status: 'resolved'; personItemId: string }
  | { status: 'anonymous' }
  | { status: 'unresolved'; reason: string; candidates: string[] };

export interface PersonResolutionRow {
  company: string;
  donorFirstName: string;
  donorLastName: string;
  email: string;
}

function isWithheld(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' || trimmed === 'not shared by donor';
}

export async function resolvePerson(
  mondayClient: MondayClient,
  config: BenevityImportConfig,
  row: PersonResolutionRow,
  organizationItemId: string
): Promise<PersonResolution> {
  const hasEmail = !isWithheld(row.email);
  const hasName = !isWithheld(row.donorFirstName) && !isWithheld(row.donorLastName);
  if (!hasEmail && !hasName) return { status: 'anonymous' };

  const peopleBoardId = config.monday.boards.people;
  const affiliationsBoardId = config.monday.boards.affiliations;
  if (peopleBoardId === null) throw new Error('config: monday.boards.people is not configured');
  if (affiliationsBoardId === null) throw new Error('config: monday.boards.affiliations is not configured');
  const { peopleColumns, affiliationsColumns } = config.benevityImport;

  if (hasEmail) {
    const email = row.email.trim().toLowerCase();
    const [byPersonalEmail, byHouseholdEmail, workEmailAffiliations] = await Promise.all([
      mondayClient.findItemsByColumnValue(peopleBoardId, peopleColumns.personalEmail, email),
      mondayClient.findItemsByColumnValue(peopleBoardId, peopleColumns.householdEmail, email),
      mondayClient.findItemsByColumnValue(affiliationsBoardId, affiliationsColumns.workEmail, email),
    ]);
    const workEmailPersonIds = (
      await Promise.all(
        workEmailAffiliations.map((affiliation) => mondayClient.getLinkedItemIds(affiliation.id, affiliationsColumns.person))
      )
    ).flat();

    const candidateIds = new Set<string>([
      ...byPersonalEmail.map((item) => item.id),
      ...byHouseholdEmail.map((item) => item.id),
      ...workEmailPersonIds,
    ]);
    if (candidateIds.size === 1) {
      return { status: 'resolved', personItemId: [...candidateIds][0]! }; // guarded by candidateIds.size === 1 above
    }
    if (candidateIds.size > 1) {
      return {
        status: 'unresolved',
        reason: `email "${row.email}" matches ${candidateIds.size} People`,
        candidates: [...candidateIds],
      };
    }
  }

  if (hasName) {
    const fullName = `${row.donorFirstName} ${row.donorLastName}`.trim().toLowerCase();
    const [nameMatches, affiliationsAtOrg, employerTextMatches] = await Promise.all([
      mondayClient.findItemsByName(peopleBoardId, `${row.donorFirstName} ${row.donorLastName}`),
      mondayClient.findItemsByColumnValue(affiliationsBoardId, affiliationsColumns.organization, organizationItemId),
      mondayClient.findItemsByColumnValue(peopleBoardId, peopleColumns.employer, row.company),
    ]);
    const exactNameMatches = nameMatches.filter((item) => item.name.trim().toLowerCase() === fullName);
    const affiliatedPersonIds = new Set(
      (
        await Promise.all(affiliationsAtOrg.map((a) => mondayClient.getLinkedItemIds(a.id, affiliationsColumns.person)))
      ).flat()
    );
    const employerTextIds = new Set(employerTextMatches.map((item) => item.id));

    const employerConfirmed = exactNameMatches.filter(
      (item) => affiliatedPersonIds.has(item.id) || employerTextIds.has(item.id)
    );
    if (employerConfirmed.length === 1) {
      return { status: 'resolved', personItemId: employerConfirmed[0]!.id }; // guarded by employerConfirmed.length === 1 above
    }
    if (employerConfirmed.length > 1) {
      return {
        status: 'unresolved',
        reason: `name "${row.donorFirstName} ${row.donorLastName}" + employer matches ${employerConfirmed.length} People`,
        candidates: employerConfirmed.map((item) => item.id),
      };
    }
  }

  return {
    status: 'unresolved',
    reason: `no email or name+employer match for "${row.donorFirstName} ${row.donorLastName}" <${row.email}>`,
    candidates: [],
  };
}
