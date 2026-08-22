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
  registrationToPayload, campaignToPayload, volunteerHoursToPayload, taskToPayload,
  emailToPayload } from './boards.js';

type Row = Record<string, unknown>;
const load = (name: string) => readNdjson<Row>(dataPath('extract', `${name}.ndjson`));

export async function runTransform(_args: string[]): Promise<number> {
  const cfg = loadConfig();
  const [contacts, accounts, opportunities, memberships, affiliations, subscriptions, pledges,
    events, registrations, campaigns, cnp, volunteerHours, tasksRecent, emailsRecent, consentRows] =
    await Promise.all([load('contacts'), load('accounts'), load('opportunities'), load('memberships'),
      load('affiliations'), load('subscriptions'), load('pledges'), load('events'),
      load('registrations'), load('campaigns'), load('clickpledge_transactions'),
      load('volunteer_hours'), load('tasks_recent'), load('emails_recent'), load('consent').catch(() => [])]);

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
  const { columns: termCols, violations: membershipViolations } = termColumnsByOpportunity(terms);

  // Inclusion sets.
  const donorOf = (o: Row) => (o['npsp__Primary_Contact__c'] ?? o['funraise__fr_Donor__c']) as string | null;
  const inc: InclusionInput = {
    donorIds: new Set(opportunities.map(donorOf).filter((x): x is string => !!x)),
    recentDonorIds: new Set(opportunities
      .filter((o) => (o['CloseDate'] as string) >= cfg.peopleActiveSinceISO)
      .map(donorOf).filter((x): x is string => !!x)),
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
  const rollups = (() => {
    const { unique } = cnpOverlapCheck(cnp, opportunities);
    return { map: donorRollups(opportunities, unique), cnpUnique: unique,
      overlap: cnp.length - unique.length };
  })();

  const payloads: ItemPayload[] = [];
  const includedContactIds = new Set<string>();

  for (const c of contacts) {
    const board = classifyContact(c, inc, cfg.peopleActiveSinceISO);
    if (!board) continue;
    includedContactIds.add(c['Id'] as string);
    const geoKey = normalizeAddress({ street: c['MailingStreet'] as string, city: c['MailingCity'] as string,
      state: c['MailingState'] as string, zip: c['MailingPostalCode'] as string });
    let p = contactToPayload(c, board, { consent, member: memberSummaries.get(c['Id'] as string),
      geo: geoKey ? geoCache.get(geoKey) : undefined, news: cfg.localNews });
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
    const p = accountToPayload(a);
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
  for (const e of events) { const p = eventToPayload(e, cfg.localNews); if (p) payloads.push(p); }
  for (const r of registrations) payloads.push(registrationToPayload(r));
  for (const k of campaigns) { const p = campaignToPayload(k, cfg.peopleActiveSinceISO); if (p) payloads.push(p); }
  for (const v of volunteerHours) payloads.push(volunteerHoursToPayload(v));
  for (const t of tasksRecent) payloads.push(taskToPayload(t));
  for (const e of emailsRecent) payloads.push(emailToPayload(e));

  // Per-board counts + ceiling assertion.
  const payloadCounts: Record<string, number> = {};
  for (const p of payloads) payloadCounts[p.board] = (payloadCounts[p.board] ?? 0) + 1;
  const ceilingViolations = Object.entries(payloadCounts)
    .filter(([, n]) => n > 10_000)
    .map(([board, n]) => `${board} projected at ${n} items (> 10,000)`);

  const report: TransformReport = {
    payloadCounts,
    assertions: [
      { name: 'membership-opportunity-1to1', violations: membershipViolations },
      { name: 'board-ceiling', violations: ceilingViolations },
    ],
    warnings: rollups.overlap > 0
      ? [`click-pledge overlap: ${rollups.overlap} transactions already present as Opportunities — deduped`]
      : [],
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
