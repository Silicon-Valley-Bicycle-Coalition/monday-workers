import type { MondayClient } from '../monday/client';
import type { BenevityImportConfig } from '../types';
import { BatchLookups } from './batchLookups';

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

export function isWithheld(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' || trimmed === 'not shared by donor';
}

export async function resolvePerson(
  mondayClient: MondayClient,
  config: BenevityImportConfig,
  row: PersonResolutionRow,
  organizationItemId: string,
  // Per-batch cache (#101): the Affiliations at an Organization and the Employer matches for a
  // company are the same for every row of a disbursement. Defaults to a fresh one per call.
  lookups: BatchLookups = new BatchLookups()
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
    const workEmailPersonIds = await mondayClient.getLinkedItemIds(
      workEmailAffiliations.map((affiliation) => affiliation.id),
      affiliationsColumns.person
    );

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
    const [nameMatches, affiliatedPeople, employerTextMatches] = await Promise.all([
      mondayClient.findItemsByName(peopleBoardId, `${row.donorFirstName} ${row.donorLastName}`),
      lookups.get(`affiliatedPeople:${organizationItemId}`, async () => {
        const affiliationsAtOrg = await mondayClient.findItemsByColumnValue(
          affiliationsBoardId,
          affiliationsColumns.organization,
          organizationItemId
        );
        return mondayClient.getLinkedItemIds(
          affiliationsAtOrg.map((a) => a.id),
          affiliationsColumns.person
        );
      }),
      lookups.get(`employer:${row.company}`, () =>
        mondayClient.findItemsByColumnValue(peopleBoardId, peopleColumns.employer, row.company)
      ),
    ]);
    const exactNameMatches = nameMatches.filter((item) => item.name.trim().toLowerCase() === fullName);
    const affiliatedPersonIds = new Set(affiliatedPeople);
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
