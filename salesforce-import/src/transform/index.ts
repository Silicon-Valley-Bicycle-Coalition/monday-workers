import { existsSync, readFileSync } from 'node:fs';
import { registerCommand } from '../commands.js';
import { loadConfig } from '../config.js';
import { dataPath, readNdjson, writeJson, writeNdjson } from '../artifacts.js';
import { GeoCache } from '../geocode/cache.js';
import { mergeableEnrichment, type MergeableEnrichment } from '../enrich/address.js';
import type { EnrichmentRow } from '../enrich/index.js';
import { normalizeAddress } from '../geocode/normalize.js';
import { setStaffMatcher } from './fields.js';
import { parseMondayUsers, staffMatcher } from './staff.js';
import type { ItemPayload, TransformReport } from './types.js';
import { deriveMembers, termColumnsByOpportunity, type MembershipRow } from './membership.js';
import { classifyContact, contactToPayload, accountToPayload, type InclusionInput } from './people.js';
import { donationArchivePlan, shouldArchive } from './schedule.js';
import { opportunityToPayload, cnpOverlapCheck, cnpToPayload } from './donations.js';
import { donorRollups, applyRollups } from './rollups.js';
import { subscriptionToPayload, pledgeColumnsBySubscription, eventToPayload, registrationToPayload,
  eventbriteEventToPayload, eventbriteAttendeeToPayload, campaignToPayload, volunteerHoursToPayload,
  taskToPayload } from './boards.js';

type Row = Record<string, unknown>;
const load = (name: string) => readNdjson<Row>(dataPath('extract', `${name}.ndjson`));

export async function runTransform(args: string[]): Promise<number> {
  const cfg = loadConfig();
  const noConsent = args.includes('--no-consent');
  const consentPath = dataPath('extract', 'consent.ndjson');
  const consentExists = existsSync(consentPath);
  if (!consentExists && !noConsent) {
    console.error('transform: data/extract/consent.ndjson not found — run ' +
      '"extract --consent <mailchimp.csv>" first, or pass --no-consent to proceed without consent data');
    return 1;
  }
  if (!consentExists) console.warn('transform: consent.ndjson not found — proceeding with ' +
    '--no-consent (empty consent map, every contact will show "Not in Mailchimp")');

  const [contacts, accounts, opportunities, memberships, affiliations, subscriptions, pledges,
    events, registrations, ebEvents, ebAttendees, campaigns, cnp, volunteerHours, tasksRecent, consentRows] =
    await Promise.all([load('contacts'), load('accounts'), load('opportunities'), load('memberships'),
      load('affiliations'), load('subscriptions'), load('pledges'), load('events'),
      load('registrations'), load('eb4sf_events'), load('eb4sf_attendees'), load('campaigns'),
      load('clickpledge_transactions'), load('volunteer_hours'), load('tasks_recent'),
      consentExists ? load('consent') : Promise.resolve([])]);

  const consent = new Map((consentRows as { email: string; status: string }[]).map((r) => [r.email, r.status]));
  const geoCache = new GeoCache();
  await geoCache.load();

  // Current-staff annotation (optional artifact): Monday's user export lets the
  // Salesforce Debug column tag audit names that are still on staff with their
  // Monday email; former staff stay verbatim.
  const staffPath = dataPath('enrich', 'monday-users.csv');
  setStaffMatcher(existsSync(staffPath)
    ? staffMatcher(parseMondayUsers(readFileSync(staffPath, 'utf8')))
    : null);

  // Places enrichment (optional artifact): exact matches plus human-approved sfIds
  // fill blank org Website/Address; enriched addresses also resolve geo.
  let enrichment = new Map<string, MergeableEnrichment>();
  const enrichPath = dataPath('enrich', 'organizations.ndjson');
  if (existsSync(enrichPath)) {
    const approvedPath = dataPath('enrich', 'approved.txt');
    const approved = new Set<string>(existsSync(approvedPath)
      ? readFileSync(approvedPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      : []);
    enrichment = mergeableEnrichment(await readNdjson<EnrichmentRow>(enrichPath), approved);
  }

  // Membership derivations + assertions.
  const terms = memberships as unknown as MembershipRow[];
  const memberSummaries = deriveMembers(terms, cfg.cutoverDateISO);
  const { columns: termCols, ambiguous: termAmbiguous } = termColumnsByOpportunity(terms);

  // Click & Pledge dedup against Opportunities, computed FIRST — the deduped C&P set feeds both
  // the People inclusion sets below (a C&P-only donor must still become a Person) and the donor
  // rollups further down, so it must exist before `inc` is built.
  const { unique: cnpUnique } = cnpOverlapCheck(cnp, opportunities);
  const cnpDonorOf = (t: Row) => t['CnP_PaaS__Contact__c'] as string | null; // Accounts aren't People — contacts only.
  const cnpDonorIds = new Set(cnpUnique.map(cnpDonorOf).filter((x): x is string => !!x));
  const cnpRecentDonorIds = new Set(cnpUnique
    .filter((t) => ((t['CnP_PaaS__TransactionDate__c'] as string) ?? '') >= cfg.peopleActiveSinceISO)
    .map(cnpDonorOf).filter((x): x is string => !!x));

  // Event registrants from both platforms: ever registered → included; registered for an event on
  // or after peopleActiveSinceISO → live (docs/11 inclusion rule + the 2026-09-08 events addendum).
  const eventStart = new Map<string, string>([
    ...events.map((e) => [e['Id'] as string, String(e['funraise__Start_Date__c'] ?? '')] as const),
    ...ebEvents.map((e) => [e['Id'] as string, String(e['eb4sf__Start__c'] ?? '')] as const),
  ]);
  const registrantRows = [
    ...registrations.map((r) => ({ contact: r['funraise__Registrant__c'] as string | null, event: r['funraise__Fundraising_Event__c'] as string | null })),
    ...ebAttendees.filter((a) => a['eb4sf__Status__c'] !== 'Deleted')
      .map((a) => ({ contact: a['eb4sf__Contact__c'] as string | null, event: a['eb4sf__Eventbrite_Event__c'] as string | null })),
  ].filter((r): r is { contact: string; event: string | null } => !!r.contact);
  const registrantIds = new Set(registrantRows.map((r) => r.contact));
  const recentRegistrantIds = new Set(registrantRows
    .filter((r) => (r.event && eventStart.get(r.event) ? eventStart.get(r.event)! : '').slice(0, 10) >= cfg.peopleActiveSinceISO)
    .map((r) => r.contact));

  // Inclusion sets.
  const donorOf = (o: Row) => (o['npsp__Primary_Contact__c'] ?? o['funraise__fr_Donor__c']) as string | null;
  const inc: InclusionInput = {
    donorIds: new Set([...opportunities.map(donorOf).filter((x): x is string => !!x), ...cnpDonorIds]),
    recentDonorIds: new Set([...opportunities
      .filter((o) => (o['CloseDate'] as string) >= cfg.peopleActiveSinceISO)
      .map(donorOf).filter((x): x is string => !!x), ...cnpRecentDonorIds]),
    memberSummaries,
    registrantIds, recentRegistrantIds,
    volunteerIds: new Set(volunteerHours.map((v) => v['GW_Volunteers__Contact__c'] as string).filter(Boolean)),
    affiliatedIds: new Set(affiliations.map((a) => a['npe5__Contact__c'] as string).filter(Boolean)),
    recentActivityIds: new Set(tasksRecent.map((t) => t['WhoId'] as string).filter(Boolean)),
  };

  const orgAccountIds = new Set(accounts
    .filter((a) => a['npe01__SYSTEM_AccountType__c'] !== 'One-to-One Individual')
    .map((a) => a['Id'] as string));
  const affiliationOrgsByContact = new Map<string, string[]>();
  for (const a of affiliations) {
    const contactId = a['npe5__Contact__c'] as string | null;
    const orgId = a['npe5__Organization__c'] as string | null;
    if (!contactId || !orgId || !orgAccountIds.has(orgId)) continue;
    if (!affiliationOrgsByContact.has(contactId)) affiliationOrgsByContact.set(contactId, []);
    affiliationOrgsByContact.get(contactId)!.push(orgId);
  }
  const rollups = { map: donorRollups(opportunities, cnpUnique), cnpUnique,
    overlap: cnp.length - cnpUnique.length };

  const payloads: ItemPayload[] = [];
  const includedContactIds = new Set<string>();

  for (const c of contacts) {
    const board = classifyContact(c, inc, cfg.peopleActiveSinceISO);
    if (!board) continue;
    includedContactIds.add(c['Id'] as string);
    const geoKey = normalizeAddress({ street: c['MailingStreet'] as string, city: c['MailingCity'] as string,
      state: c['MailingState'] as string, zip: c['MailingPostalCode'] as string });
    let p = contactToPayload(c, board, { consent, member: memberSummaries.get(c['Id'] as string),
      geo: geoKey ? geoCache.get(geoKey) : undefined });
    // Organization link = the Contact's own org Account (if any) ∪ its Affiliation orgs (doc 05 §1b:
    // all 6,349 Affiliations migrate onto this connect column — one Person, many Organizations).
    const affilOrgs = affiliationOrgsByContact.get(c['Id'] as string) ?? [];
    const ownOrg = (p.links ?? []).flatMap((l) => l.column === 'Organization' ? l.targetSfIds : [])
      .filter((id) => orgAccountIds.has(id));
    const orgTargets = [...new Set([...ownOrg, ...affilOrgs])];
    p = { ...p, links: [
      ...(p.links ?? []).filter((l) => l.column !== 'Organization'),
      ...(orgTargets.length > 0 ? [{ column: 'Organization', targetSfIds: orgTargets }] : []),
    ] };
    const r = rollups.map.get(c['Id'] as string);
    payloads.push(r ? applyRollups(p, r) : p);
  }
  for (const a of accounts) {
    const enriched = enrichment.get(a['Id'] as string);
    const billingKey = normalizeAddress({ street: a['BillingStreet'] as string, city: a['BillingCity'] as string,
      state: a['BillingState'] as string, zip: a['BillingPostalCode'] as string });
    const enrichedKey = enriched?.parts ? normalizeAddress(enriched.parts) : null;
    const geoKey = billingKey ?? enrichedKey;
    const p = accountToPayload(a, geoKey ? geoCache.get(geoKey) : undefined);
    if (!p) continue;
    if (enriched) {
      if (!p.columns['Website'] && enriched.website) p.columns['Website'] = enriched.website;
      if (!p.columns['Address'] && enriched.address) p.columns['Address'] = enriched.address;
    }
    const r = rollups.map.get(a['Id'] as string);
    payloads.push(r ? applyRollups(p, r) : p);
  }
  for (const o of opportunities) payloads.push(opportunityToPayload(o, { termCols }));
  for (const t of rollups.cnpUnique) payloads.push(cnpToPayload(t));

  const pledgeCols = pledgeColumnsBySubscription(pledges);
  for (const s of subscriptions) {
    const p = subscriptionToPayload(s);
    if (p) payloads.push({ ...p, columns: { ...p.columns, ...(pledgeCols.get(p.sfId) ?? {}) } });
  }
  for (const e of events) { const p = eventToPayload(e, cfg.cutoverDateISO); if (p) payloads.push(p); }
  for (const r of registrations) payloads.push(registrationToPayload(r));
  const ebEventById = new Map(ebEvents.map((e) => [e['Id'] as string, e]));
  const ebEventsWithAttendees = new Set(ebAttendees.map((a) => a['eb4sf__Eventbrite_Event__c'] as string));
  for (const e of ebEvents) {
    const p = eventbriteEventToPayload(e, { hasAttendees: ebEventsWithAttendees.has(e['Id'] as string) });
    if (p) payloads.push(p);
  }
  for (const a of ebAttendees) {
    const p = eventbriteAttendeeToPayload(a, ebEventById.get(a['eb4sf__Eventbrite_Event__c'] as string));
    if (p) payloads.push(p);
  }
  for (const k of campaigns) { const p = campaignToPayload(k, cfg.peopleActiveSinceISO); if (p) payloads.push(p); }
  for (const v of volunteerHours) payloads.push(volunteerHoursToPayload(v));
  // Activities: person-linked Tasks only, newest-first, capped under the board ceiling
  // (decided 2026-08-22 after the real slice measured 53k). EmailMessages carry no contact
  // link and stay backup-only.
  const linkedTasks = tasksRecent
    .filter((t) => includedContactIds.has(t['WhoId'] as string))
    .sort((a, b) => String(b['ActivityDate'] ?? '').localeCompare(String(a['ActivityDate'] ?? '')));
  const fittedTasks = linkedTasks.slice(0, cfg.boardMaxItems);
  const activityCutoff = fittedTasks.at(-1)?.['ActivityDate'] ?? null;
  for (const t of fittedTasks) payloads.push(taskToPayload(t));

  // Donations archive-in-place plan: gifts before the retention window get flagged for load
  // to archive after their fiscal year's items and links land (docs/20). The board's TOTAL
  // exceeds the ceiling by design — only the peak ACTIVE count has to stay under it.
  const donationPayloads = payloads.filter((p) => p.board === 'donations');
  const plan = donationArchivePlan(donationPayloads, cfg.cutoverDateISO, cfg.donationsActiveFiscalYears);
  let archiveCount = 0;
  for (const p of donationPayloads) {
    if (shouldArchive(p, plan)) { p.archive = true; archiveCount++; }
  }

  // Per-board counts + ceiling assertion (donations asserts on peak active, not total).
  const payloadCounts: Record<string, number> = {};
  for (const p of payloads) payloadCounts[p.board] = (payloadCounts[p.board] ?? 0) + 1;
  const ceilingViolations = Object.entries(payloadCounts)
    .filter(([board, n]) => (board === 'donations' ? plan.peakActive : n) > 10_000)
    .map(([board, n]) => board === 'donations'
      ? `donations peak active projected at ${plan.peakActive} items (> 10,000)`
      : `${board} projected at ${n} items (> 10,000)`);

  const warnings: string[] = [];
  if (rollups.overlap > 0) {
    warnings.push(`click-pledge overlap: ${rollups.overlap} transactions already present as Opportunities — deduped`);
  }
  if (termAmbiguous.length > 0) {
    warnings.push(`membership term columns skipped for ${termAmbiguous.length} opportunities with ` +
      `disagreeing terms (joint memberships with matching terms ARE written; first: ${termAmbiguous[0]})`);
  }
  warnings.push(`activities: ${fittedTasks.length} of ${linkedTasks.length} person-linked tasks ` +
    `(cutoff ${activityCutoff ?? 'n/a'}); ${tasksRecent.length - linkedTasks.length} unlinked tasks and all ` +
    `emails are backup-only`);
  warnings.push(`donations: ${archiveCount} of ${donationPayloads.length} flagged for archive ` +
    `(fiscal years before FY${plan.cutoffFY}); peak active ${plan.peakActive}`);
  const report: TransformReport = {
    payloadCounts,
    assertions: [
      { name: 'board-ceiling', violations: ceilingViolations },
    ],
    warnings,
  };

  await writeNdjson(dataPath('transform', 'payloads.ndjson'), payloads);
  await writeJson(dataPath('transform', 'report.json'), report);

  console.log(`transform: ${payloads.length} payloads, ${includedContactIds.size} people included`);
  for (const a of report.assertions) {
    if (a.violations.length > 0) {
      console.error(`transform: ASSERTION FAILED ${a.name}: ${a.violations.length} violations ` +
        `(first: ${a.violations[0]})`);
    }
  }
  return report.assertions.some((a) => a.violations.length > 0) ? 1 : 0;
}

registerCommand('transform', (args) => runTransform(args));
