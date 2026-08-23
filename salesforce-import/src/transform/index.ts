import { existsSync } from 'node:fs';
import { registerCommand } from '../commands.js';
import { loadConfig } from '../config.js';
import { dataPath, readNdjson, writeJson, writeNdjson } from '../artifacts.js';
import { GeoCache } from '../geocode/cache.js';
import { normalizeAddress } from '../geocode/normalize.js';
import type { ItemPayload, TransformReport } from './types.js';
import { deriveMembers, termColumnsByOpportunity, type MembershipRow } from './membership.js';
import { classifyContact, contactToPayload, accountToPayload, type InclusionInput } from './people.js';
import { computeEras, type Era } from './eras.js';
import { opportunityToPayload, cnpOverlapCheck, cnpToPayload } from './donations.js';
import { donorRollups, applyRollups } from './rollups.js';
import { subscriptionToPayload, pledgeColumnsBySubscription, eventToPayload,
  registrationToPayload, campaignToPayload, volunteerHoursToPayload, taskToPayload } from './boards.js';

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
    events, registrations, campaigns, cnp, volunteerHours, tasksRecent, consentRows] =
    await Promise.all([load('contacts'), load('accounts'), load('opportunities'), load('memberships'),
      load('affiliations'), load('subscriptions'), load('pledges'), load('events'),
      load('registrations'), load('campaigns'), load('clickpledge_transactions'),
      load('volunteer_hours'), load('tasks_recent'),
      consentExists ? load('consent') : Promise.resolve([])]);

  const consent = new Map((consentRows as { email: string; status: string }[]).map((r) => [r.email, r.status]));
  const geoCache = new GeoCache();
  await geoCache.load();

  // Eras from all dated donation rows.
  const eras: Era[] = computeEras([
    ...opportunities.map((o) => o['CloseDate'] as string).filter(Boolean),
    ...cnp.map((t) => (t['CnP_PaaS__TransactionDate__c'] as string) ?? '').filter(Boolean),
  ], cfg.eraMaxItems);

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

  // Inclusion sets.
  const donorOf = (o: Row) => (o['npsp__Primary_Contact__c'] ?? o['funraise__fr_Donor__c']) as string | null;
  const inc: InclusionInput = {
    donorIds: new Set([...opportunities.map(donorOf).filter((x): x is string => !!x), ...cnpDonorIds]),
    recentDonorIds: new Set([...opportunities
      .filter((o) => (o['CloseDate'] as string) >= cfg.peopleActiveSinceISO)
      .map(donorOf).filter((x): x is string => !!x), ...cnpRecentDonorIds]),
    memberSummaries,
    registrantIds: new Set(registrations.map((r) => r['funraise__Registrant__c'] as string).filter(Boolean)),
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
    const geoKey = normalizeAddress({ street: a['BillingStreet'] as string, city: a['BillingCity'] as string,
      state: a['BillingState'] as string, zip: a['BillingPostalCode'] as string });
    const p = accountToPayload(a, geoKey ? geoCache.get(geoKey) : undefined);
    if (!p) continue;
    const r = rollups.map.get(a['Id'] as string);
    payloads.push(r ? applyRollups(p, r) : p);
  }
  for (const o of opportunities) payloads.push(opportunityToPayload(o, { eras, termCols }));
  for (const t of rollups.cnpUnique) payloads.push(cnpToPayload(t, { eras }));

  const pledgeCols = pledgeColumnsBySubscription(pledges);
  for (const s of subscriptions) {
    const p = subscriptionToPayload(s);
    if (p) payloads.push({ ...p, columns: { ...p.columns, ...(pledgeCols.get(p.sfId) ?? {}) } });
  }
  for (const e of events) { const p = eventToPayload(e); if (p) payloads.push(p); }
  for (const r of registrations) payloads.push(registrationToPayload(r));
  for (const k of campaigns) { const p = campaignToPayload(k, cfg.peopleActiveSinceISO); if (p) payloads.push(p); }
  for (const v of volunteerHours) payloads.push(volunteerHoursToPayload(v));
  // Activities: person-linked Tasks only, newest-first, capped under the board ceiling
  // (decided 2026-08-22 after the real slice measured 53k). EmailMessages carry no contact
  // link and stay backup-only.
  const linkedTasks = tasksRecent
    .filter((t) => includedContactIds.has(t['WhoId'] as string))
    .sort((a, b) => String(b['ActivityDate'] ?? '').localeCompare(String(a['ActivityDate'] ?? '')));
  const fittedTasks = linkedTasks.slice(0, cfg.eraMaxItems);
  const activityCutoff = fittedTasks.at(-1)?.['ActivityDate'] ?? null;
  for (const t of fittedTasks) payloads.push(taskToPayload(t));

  // Per-board counts + ceiling assertion.
  const payloadCounts: Record<string, number> = {};
  for (const p of payloads) payloadCounts[p.board] = (payloadCounts[p.board] ?? 0) + 1;
  const ceilingViolations = Object.entries(payloadCounts)
    .filter(([, n]) => n > 10_000)
    .map(([board, n]) => `${board} projected at ${n} items (> 10,000)`);

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
  const report: TransformReport = {
    payloadCounts,
    assertions: [
      { name: 'board-ceiling', violations: ceilingViolations },
    ],
    warnings,
  };

  await writeNdjson(dataPath('transform', 'payloads.ndjson'), payloads);
  await writeJson(dataPath('transform', 'eras.json'), eras);
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
