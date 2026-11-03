import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { registerCommand } from '../commands.js';
import { loadConfig } from '../config.js';
import { dataPath, readNdjson, writeJson, writeNdjson } from '../artifacts.js';
import { GeoCache } from '../geocode/cache.js';
import { mergeableEnrichment, type MergeableEnrichment } from '../enrich/address.js';
import type { EnrichmentRow } from '../enrich/index.js';
import { normalizeAddress } from '../geocode/normalize.js';
import { collapseEmail, setOwnerMatcher, setStaffMatcher } from './fields.js';
import { exactStaffMatcher, parseMondayUsers, staffMatcher } from './staff.js';
import type { ItemPayload, TransformReport } from './types.js';
import { deriveMembers, termColumnsByOpportunity, type MembershipRow } from './membership.js';
import { classifyContact, contactToPayload, accountToPayload, isOneToOneAccount, personNamedAccountIds,
  rosterContactIds, soleContactAccountIds,
  type InclusionInput } from './people.js';
import { donationArchivePlan, shouldArchive } from './schedule.js';
import { opportunityToPayload, cnpGiftDay, cnpOverlapCheck, cnpToPayload, softCreditsByGift, unknownStages,
  eventbriteOrderIdsByOpportunity, foldFeeCoverage } from './donations.js';
import { donorRollups, applyRollups } from './rollups.js';
import { activeRecurringDonors, subscriptionToPayload, pledgeColumnsBySubscription, eventToPayload,
  registrationToPayload, eventbriteEventToPayload, eventbriteAttendeeToPayload, campaignToPayload,
  volunteerHoursToPayload, taskToPayload } from './boards.js';
import { DEFAULT_CONSUMER_DOMAINS, websiteDomain } from './emailKind.js';
import { assignEmails, parseEmailKindOverrides, type AffiliationRef, type EmailOverride } from './emails.js';
import { affiliationToPayload, affiliationStatus } from './affiliations.js';
import { AffiliationIndex, attributeOpportunity, attributeRegistration, attributionRollups,
  type AffiliationEntry } from './attribution.js';

type Row = Record<string, unknown>;
const load = (name: string) => readNdjson<Row>(dataPath('extract', `${name}.ndjson`));

// RFC 4180: quote a field when it holds a comma, quote, or newline; double any quotes inside.
const csvField = (v: unknown): string => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

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

  const [contacts, accounts, rawOpportunities, contactRoles, memberships, affiliations, subscriptions, pledges,
    events, registrations, ebEvents, ebAttendees, campaigns, cnp, volunteerHours, tasksRecent, consentRows] =
    await Promise.all([load('contacts'), load('accounts'), load('opportunities'), load('contact_roles'),
      load('memberships'), load('affiliations'), load('subscriptions'), load('pledges'), load('events'),
      load('registrations'), load('eb4sf_events'), load('eb4sf_attendees'), load('campaigns'),
      load('clickpledge_transactions'), load('volunteer_hours'), load('tasks_recent'),
      consentExists ? load('consent') : Promise.resolve([])]);
  // Fee-coverage splits fold into their gifts before anything reads Opportunities, so rollups,
  // donor inclusion and the Donations payloads all see one gift per donor payment.
  const feeFold = foldFeeCoverage(rawOpportunities);
  const opportunities = feeFold.gifts;

  const consent = new Map((consentRows as { email: string; status: string }[]).map((r) => [r.email, r.status]));
  const geoCache = new GeoCache();
  await geoCache.load();

  // Current-staff annotation (optional artifact): Monday's user export lets the
  // Salesforce Debug column tag audit names that are still on staff with their
  // Monday email; former staff stay verbatim.
  const staffPath = dataPath('enrich', 'monday-users.csv');
  const staff = existsSync(staffPath) ? parseMondayUsers(readFileSync(staffPath, 'utf8')) : null;
  setStaffMatcher(staff ? staffMatcher(staff) : null);
  // Without the export, Relationship Owner loads empty on everyone.
  setOwnerMatcher(staff ? exactStaffMatcher(staff) : null);
  if (!staff) console.warn('transform: data/enrich/monday-users.csv not found — Relationship Owner stays empty');

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

  // Person/organization split. One-to-one Accounts are People by NPSP's own stamp; blank-type
  // Accounts named after their sole Contact are People NPSP never stamped (Account-first imports,
  // Click & Pledge) and fold into that Contact — no Organization item, and anything booked
  // against the Account (gifts, links) re-points at the person. One a contact merge left with no
  // Contact folds into the same-named Contact its gifts name.
  const personNamed = personNamedAccountIds(accounts, contacts, opportunities);
  const orgAccountIds = new Set(accounts
    .filter((a) => !isOneToOneAccount(a) && !personNamed.has(a['Id'] as string))
    .map((a) => a['Id'] as string));

  // Click & Pledge dedup against Opportunities, computed FIRST — the deduped C&P set feeds both
  // the People inclusion sets below (a C&P-only donor must still become a Person) and the donor
  // rollups further down, so it must exist before `inc` is built.
  const { unique: cnpUnique } = cnpOverlapCheck(cnp, opportunities);
  // Organizations aren't People, so only Contact-keyed (or person-folded Account) C&P gifts confer inclusion.
  const cnpDonorOf = (t: Row) => (t['CnP_PaaS__Contact__c'] as string | null)
    ?? personNamed.get(t['CnP_PaaS__Account__c'] as string) ?? null;
  const cnpDonorIds = new Set(cnpUnique.map(cnpDonorOf).filter((x): x is string => !!x));
  const cnpRecentDonorIds = new Set(cnpUnique
    .filter((t) => (cnpGiftDay(t) ?? '') >= cfg.peopleActiveSinceISO)
    .map(cnpDonorOf).filter((x): x is string => !!x));

  // Event registrants from both platforms feed People inclusion: a Funraise registration (a paid
  // ticket) or an Eventbrite CHECK-IN counts; an Eventbrite registration nobody showed up for does
  // not — decision D, 2026-09-08: free-class no-shows and cancellations are email-list-grade
  // contacts, and counting them (4,308 Contacts) pushed both People boards past the 10k ceiling.
  // A counted registration for an event on/after peopleActiveSinceISO makes the Person live.
  // Attendee rows themselves still land on event-registrations regardless (the Attendee link is
  // simply skipped at load when the Contact isn't a Person).
  const eventStart = new Map<string, string>([
    ...events.map((e) => [e['Id'] as string, String(e['funraise__Start_Date__c'] ?? '')] as const),
    ...ebEvents.map((e) => [e['Id'] as string, String(e['eb4sf__Start__c'] ?? '')] as const),
  ]);
  const registrantRows = [
    ...registrations.map((r) => ({ contact: r['funraise__Registrant__c'] as string | null, event: r['funraise__Fundraising_Event__c'] as string | null })),
    ...ebAttendees.filter((a) => a['eb4sf__Status__c'] !== 'Deleted' && a['eb4sf__Checked_In__c'] === true)
      .map((a) => ({ contact: a['eb4sf__Contact__c'] as string | null, event: a['eb4sf__Eventbrite_Event__c'] as string | null })),
  ].filter((r): r is { contact: string; event: string | null } => !!r.contact);
  const registrantIds = new Set(registrantRows.map((r) => r.contact));
  const recentRegistrantIds = new Set(registrantRows
    .filter((r) => (r.event && eventStart.get(r.event) ? eventStart.get(r.event)! : '').slice(0, 10) >= cfg.peopleActiveSinceISO)
    .map((r) => r.contact));

  // Inclusion sets.
  const donorOf = (o: Row) => ((o['npsp__Primary_Contact__c'] ?? o['funraise__fr_Donor__c']) as string | null)
    ?? personNamed.get(o['AccountId'] as string) ?? null;
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
  // Rostered volunteers (optional artifact): Contact ids from the board-linking survey's Volunteer
  // Roster rows count toward inclusion, so the roster's Person links resolve at cutover.
  const rosterPath = dataPath('enrich', 'roster-contacts.txt');
  if (existsSync(rosterPath)) inc.rosterIds = rosterContactIds(readFileSync(rosterPath, 'utf8'), contacts);

  // ---- Affiliations: one item per person-at-organization tenure (spec: affiliation model) ----
  const orgAffiliations = affiliations.filter((a) =>
    a['npe5__Contact__c'] && a['npe5__Organization__c'] && orgAccountIds.has(a['npe5__Organization__c'] as string));
  const affiliationsByContact = new Map<string, Record<string, unknown>[]>();
  for (const a of orgAffiliations) {
    const contactId = a['npe5__Contact__c'] as string;
    (affiliationsByContact.get(contactId) ?? affiliationsByContact.set(contactId, []).get(contactId)!).push(a);
  }
  const accountById = new Map(accounts.map((a) => [a['Id'] as string, a]));
  const contactById = new Map(contacts.map((c) => [c['Id'] as string, c]));
  const orgDomainByOrgId = new Map<string, string>();
  for (const a of accounts) {
    if (!orgAccountIds.has(a['Id'] as string)) continue;
    const site = (a['Website'] as string | null) || enrichment.get(a['Id'] as string)?.website || null;
    const domain = websiteDomain(site);
    if (domain) orgDomainByOrgId.set(a['Id'] as string, domain);
  }
  const consumerDomains = new Set(cfg.consumerEmailDomains ?? DEFAULT_CONSUMER_DOMAINS);
  const overridesPath = dataPath('enrich', 'email-kinds.csv');
  const overrides: Map<string, EmailOverride> = existsSync(overridesPath)
    ? parseEmailKindOverrides(readFileSync(overridesPath, 'utf8')) : new Map();

  const warnings: string[] = [];

  // Pass A: classify every included contact's addresses. Sorted by Id so "first person with a
  // given Household Email" is deterministic run to run.
  const assignments = new Map<string, ReturnType<typeof assignEmails>>();
  const boardOf = new Map<string, 'people-live' | 'people-historical'>();
  const emailStats = { work: 0, household: 0, review: 0, swapped: 0 };
  const emailReviewRows: string[] = [];
  // Byte-stable comparison, not locale-aware collation — "first by Id" must be the same order on
  // every machine regardless of ICU/locale settings.
  const byId = (x: Row, y: Row): number => {
    const a = String(x['Id']), b = String(y['Id']);
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const placeholderDonorSfIds = new Set(cfg.placeholderDonorSfIds ?? []);
  const sortedContacts = [...contacts].sort(byId);
  for (const c of sortedContacts) {
    const id = c['Id'] as string;
    if (placeholderDonorSfIds.has(id)) continue; // "Anonymous Person" is not a Person
    const board = classifyContact(c, inc, cfg.peopleActiveSinceISO);
    if (!board) continue;
    boardOf.set(id, board);
    const refs: AffiliationRef[] = (affiliationsByContact.get(id) ?? []).map((a) => ({
      sfId: a['Id'] as string, orgSfId: a['npe5__Organization__c'] as string, primary: a['npe5__Primary__c'] === true,
      status: affiliationStatus(a['npe5__Status__c']) }));
    // An override naming an affiliation this contact doesn't have would otherwise be trusted
    // verbatim by assignEmails, silently keying a work address to a tenure that never resolves
    // it back on any payload (see the review finding). Reject it here, before classification.
    const refSfIds = new Set(refs.map((ref) => ref.sfId));
    let contactOverrides = overrides;
    for (const email of [collapseEmail(c), (c['Secondary_Email__c'] as string | null)?.trim().toLowerCase() || null]) {
      if (!email) continue;
      const o = overrides.get(email);
      if (o?.kind === 'work' && o.affiliationSfId && !refSfIds.has(o.affiliationSfId)) {
        warnings.push(`emails: override for ${email} names affiliation ${o.affiliationSfId}, which ${id} does not have — ignored`);
        if (contactOverrides === overrides) contactOverrides = new Map(overrides);
        contactOverrides.delete(email);
      }
    }
    const asg = assignEmails(c, refs, orgDomainByOrgId, consumerDomains, contactOverrides);
    assignments.set(id, asg);
    emailStats.work += asg.work.size;
    if (asg.household) emailStats.household++;
    if (asg.swapped) emailStats.swapped++;
    for (const r of asg.review) {
      emailStats.review++;
      const name = [c['FirstName'], c['LastName']].filter(Boolean).join(' ');
      const candidates = refs.map((ref) => `${ref.sfId}:${accountById.get(ref.orgSfId)?.['Name'] ?? ''}`).join(';');
      emailReviewRows.push([id, name, r.email, r.domain, candidates].map(csvField).join(','));
    }
  }
  const householdPrimaryOf = new Map<string, string>();   // household email → first contact Id
  for (const c of sortedContacts) {
    const asg = assignments.get(c['Id'] as string);
    if (asg?.household && !householdPrimaryOf.has(asg.household)) householdPrimaryOf.set(asg.household, c['Id'] as string);
  }

  // Pass B: the affiliation index (work emails + tenures) drives attribution of gifts and
  // registrations before any payload is built, so seed rollups can land on both sides.
  const affiliationEntries: AffiliationEntry[] = orgAffiliations
    .filter((a) => boardOf.has(a['npe5__Contact__c'] as string))
    .map((a) => ({
      sfId: a['Id'] as string, contactSfId: a['npe5__Contact__c'] as string, orgSfId: a['npe5__Organization__c'] as string,
      startISO: (a['npe5__StartDate__c'] as string | null) ?? null, endISO: (a['npe5__EndDate__c'] as string | null) ?? null,
      primary: a['npe5__Primary__c'] === true,
      workEmail: assignments.get(a['npe5__Contact__c'] as string)?.work.get(a['Id'] as string) ?? null }));
  // Work Email is spec'd unique across Affiliations, but two different contacts at one org can
  // share a mailbox (e.g. info@) as their Secondary_Email__c, so both get a Work Email pointing
  // at the same address. Picking one arbitrarily (extract order, no ORDER BY) would attribute
  // registrations to the wrong tenure — so any address claimed by more than one affiliation is
  // excluded from attribution matching entirely (byWorkEmail below). The Affiliation board items
  // still carry the address on each item — only matching is affected.
  const entriesByWorkEmail = new Map<string, AffiliationEntry[]>();
  for (const e of affiliationEntries) {
    if (!e.workEmail) continue;
    const key = e.workEmail.trim().toLowerCase();
    (entriesByWorkEmail.get(key) ?? entriesByWorkEmail.set(key, []).get(key)!).push(e);
  }
  for (const [emailKey, claimants] of entriesByWorkEmail) {
    if (claimants.length <= 1) continue;
    warnings.push(`emails: work address ${emailKey} is claimed by ${claimants.length} affiliations ` +
      `(${claimants.map((e) => e.sfId).join(', ')}) — excluded from attribution matching`);
    for (const e of claimants) e.workEmail = null;
  }
  const affiliationIndex = new AffiliationIndex(affiliationEntries);
  const attributedOpps = new Map<string, string>();
  const unaffiliatedRows: string[] = [];
  for (const o of opportunities) {
    const att = attributeOpportunity(o, affiliationIndex, orgAccountIds);
    if (att && 'affiliationSfId' in att) attributedOpps.set(o['Id'] as string, att.affiliationSfId);
    else if (att && 'unaffiliated' in att) {
      unaffiliatedRows.push([o['Id'], att.unaffiliated.contactSfId, att.unaffiliated.orgSfId,
        accountById.get(att.unaffiliated.orgSfId)?.['Name'] ?? '', o['Amount'] ?? '',
        String(o['CloseDate'] ?? '').slice(0, 10)].map(csvField).join(','));
    }
  }
  const attributedRegs = new Map<string, { affiliationSfId: string; attribution: 'Auto' | 'Needs review' }>();
  for (const r of registrations) {
    const att = attributeRegistration(r, affiliationIndex);
    if (att) attributedRegs.set(r['Id'] as string, att);
  }
  const attRollups = attributionRollups(opportunities, attributedOpps, affiliationIndex);

  // Gifts whose donor falls through to a One-to-One Account (no Primary Contact, no Funraise
  // donor) credit its sole migrated Contact; the rest load donor-less and go to review
  // (decided 2026-10-26, monday-migration docs/24). Built from boardOf, so inclusion is unchanged.
  const personAccounts = soleContactAccountIds(accounts, contacts, new Set(boardOf.keys()));
  const donorAlias = new Map([...personNamed, ...personAccounts.alias]);
  const personAccountIds = new Set(accounts.filter(isOneToOneAccount).map((a) => a['Id'] as string));
  let personAccountLinked = 0;
  const personAccountRows: string[] = [];
  const notePersonAccountGift = (accountId: string | null, sfId: unknown, amount: unknown, dateISO: unknown) => {
    if (!accountId || placeholderDonorSfIds.has(accountId)) return;
    if (personAccounts.alias.has(accountId)) { personAccountLinked++; return; }
    const reason = personAccounts.unresolved.get(accountId);
    if (reason) {
      personAccountRows.push([sfId, accountId, accountById.get(accountId)?.['Name'] ?? '', reason, amount ?? '',
        String(dateISO ?? '').slice(0, 10)].map(csvField).join(','));
    }
  };
  // Personal / organization rollups follow the Donor link, which follows attribution — so
  // they are computed only now that attributedOpps exists (see donations.ts giftDonorSfId).
  const rollups = { map: donorRollups(opportunities, cnpUnique, donorAlias, { orgAccountIds, attributed: attributedOpps },
    cfg.eventbriteIntegrationUserName), cnpUnique, overlap: cnp.length - cnpUnique.length };

  const payloads: ItemPayload[] = [];
  const includedContactIds = new Set<string>();

  const activeRecurring = activeRecurringDonors(subscriptions);
  for (const c of sortedContacts) {
    const id = c['Id'] as string;
    const board = boardOf.get(id);
    if (!board) continue;
    includedContactIds.add(id);
    const asg = assignments.get(id)!;
    const geoKey = normalizeAddress({ street: c['MailingStreet'] as string, city: c['MailingCity'] as string,
      state: c['MailingState'] as string, zip: c['MailingPostalCode'] as string });
    const myAffiliations = affiliationsByContact.get(id) ?? [];
    let p = contactToPayload(c, board, { consent, member: memberSummaries.get(id),
      geo: geoKey ? geoCache.get(geoKey) : undefined,
      emails: { personal: asg.personal, household: asg.household },
      householdPrimary: asg.household !== null && householdPrimaryOf.get(asg.household) === id,
      affiliationSfIds: myAffiliations.map((a) => a['Id'] as string) });
    // Organization link = the Contact's own org Account (if any) ∪ its CURRENT affiliation orgs.
    // Former tenures live on the Affiliations board, not on the person's Organization column.
    const currentOrgs = myAffiliations.filter((a) => affiliationStatus(a['npe5__Status__c']) === 'Current')
      .map((a) => a['npe5__Organization__c'] as string);
    const ownOrg = (p.links ?? []).flatMap((l) => l.column === 'Organization' ? l.targetSfIds : [])
      .filter((oid) => orgAccountIds.has(oid));
    const orgTargets = [...new Set([...ownOrg, ...currentOrgs])];
    p = { ...p, links: [
      ...(p.links ?? []).filter((l) => l.column !== 'Organization'),
      ...(orgTargets.length > 0 ? [{ column: 'Organization', targetSfIds: orgTargets }] : []),
    ] };
    const orgGiving = attRollups.organizationalGivingByContact.get(id);
    if (orgGiving !== undefined) p.columns['Organizational Giving'] = String(orgGiving);
    // Always declared, so load creates the column the Postal appeal list filters on.
    p.columns['Has Active Recurring Gift'] = activeRecurring.has(id) ? { checked: 'true' } : null;
    const r = rollups.map.get(id);
    payloads.push(r ? applyRollups(p, r) : p);
  }
  for (const a of orgAffiliations) {
    const contactId = a['npe5__Contact__c'] as string;
    if (!boardOf.has(contactId)) continue;   // contact not migrated → no dangling tenure
    const c = contactById.get(contactId)!;
    const p = affiliationToPayload(a, {
      personName: [c['FirstName'], c['LastName']].filter(Boolean).join(' ') || '(no name)',
      orgName: (accountById.get(a['npe5__Organization__c'] as string)?.['Name'] as string) ?? '(no name)',
      workEmail: assignments.get(contactId)?.work.get(a['Id'] as string) ?? null, consent });
    const ar = attRollups.byAffiliation.get(a['Id'] as string);
    if (ar) {
      p.columns['Attributed Giving'] = String(ar.giving);
      p.columns['Attributed Gift Count'] = String(ar.giftCount);
      p.columns['Last Attributed Gift'] = ar.lastGiftISO ? { date: ar.lastGiftISO } : null;
    }
    payloads.push(p);
  }
  for (const a of accounts) {
    if (personNamed.has(a['Id'] as string)) continue; // folded into its Contact above
    if (placeholderDonorSfIds.has(a['Id'] as string)) continue;
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
      if (!p.columns['City'] && enriched.parts?.city) p.columns['City'] = enriched.parts.city;
      if (!p.columns['Zip'] && enriched.parts?.zip) p.columns['Zip'] = enriched.parts.zip;
    }
    const r = rollups.map.get(a['Id'] as string);
    payloads.push(r ? applyRollups(p, r) : p);
  }
  const softCredits = softCreditsByGift(contactRoles, opportunities, placeholderDonorSfIds);
  // Optional so an extract from before the eb4sf_orders query still transforms, but a cutover
  // load without it leaves every ticket gift unstamped, and eventbrite-sync would duplicate them.
  const ordersPath = dataPath('extract', 'eb4sf_orders.ndjson');
  const ordersExist = existsSync(ordersPath);
  if (!ordersExist) {
    warnings.push('donations: eb4sf_orders.ndjson not found — no gift gets an Eventbrite Order ID; ' +
      're-run extract before a real load, or eventbrite-sync will duplicate migrated ticket gifts');
  }
  const ebOrders = eventbriteOrderIdsByOpportunity(ordersExist ? await load('eb4sf_orders') : []);
  for (const o of opportunities) {
    if (!o['npsp__Primary_Contact__c'] && !o['funraise__fr_Donor__c']) {
      notePersonAccountGift(o['AccountId'] as string | null, o['Id'], o['Amount'], o['CloseDate']);
    }
    payloads.push(opportunityToPayload(o, { termCols, donorAlias, orgAccountIds, placeholderDonorSfIds, personAccountIds,
      actingFor: attributedOpps.get(o['Id'] as string) ?? null, softCredits: softCredits.get(o['Id'] as string),
      eventbriteIntegrationUserName: cfg.eventbriteIntegrationUserName,
      eventbriteOrderId: ebOrders.byOpportunity.get(o['Id'] as string) ?? null }));
  }
  if (ebOrders.multiOrderOpportunities > 0) {
    warnings.push(`donations: ${ebOrders.multiOrderOpportunities} gifts link more than one Eventbrite order; ` +
      'each keeps the lowest order id, so eventbrite-sync creates a separate item for the others');
  }
  for (const t of rollups.cnpUnique) {
    if (!t['CnP_PaaS__Contact__c']) {
      notePersonAccountGift(t['CnP_PaaS__Account__c'] as string | null, t['Id'], t['CnP_PaaS__TotalCharged__c'],
        cnpGiftDay(t));
    }
    payloads.push(cnpToPayload(t, donorAlias, personAccountIds));
  }

  const pledgeCols = pledgeColumnsBySubscription(pledges);
  for (const s of subscriptions) {
    const p = subscriptionToPayload(s);
    if (p) payloads.push({ ...p, columns: { ...p.columns, ...(pledgeCols.get(p.sfId) ?? {}) } });
  }
  for (const e of events) { const p = eventToPayload(e, cfg.cutoverDateISO); if (p) payloads.push(p); }
  for (const r of registrations) {
    const att = attributedRegs.get(r['Id'] as string);
    payloads.push(registrationToPayload(r, { actingFor: att?.affiliationSfId ?? null, attribution: att?.attribution }));
  }
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
  const giftCampaignIds = new Set(opportunities.map((o) => o['CampaignId'] as string | null).filter((x): x is string => !!x));
  for (const k of campaigns) { const p = campaignToPayload(k, cfg.peopleActiveSinceISO, giftCampaignIds); if (p) payloads.push(p); }
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

  // Skipped links: a link whose target isn't a payload is dropped at load ("targets not
  // migrated"). 18,623 surfaced only in the loader's closing line in the 2026-10-09 rehearsal
  // (monday-migration docs/24), so any not expected by design now fails the transform.
  const migratedSfIds = new Set(payloads.map((p) => p.sfId));
  const expectedSkips: Record<string, string> = {
    'event-registrations → Attendee': 'registrants who never checked in are not People (decision D)',
    'donations → Soft Credit': 'soft credits naming a contact who is not a Person',
  };
  const skipped = new Map<string, { count: number; first: string }>();
  for (const p of payloads) {
    for (const l of p.links ?? []) {
      const missing = l.targetSfIds.find((t) => !migratedSfIds.has(t));
      if (!missing) continue;
      const key = `${p.board} → ${l.column}`;
      const s = skipped.get(key);
      if (s) s.count++; else skipped.set(key, { count: 1, first: `${p.sfId} → ${missing}` });
    }
  }
  const skippedLinkViolations: string[] = [];
  for (const [key, { count, first }] of skipped) {
    if (expectedSkips[key]) warnings.push(`links: ${count} ${key} links skip unmigrated targets — ${expectedSkips[key]}`);
    else skippedLinkViolations.push(`${key}: ${count} links (first: ${first})`);
  }
  warnings.push(`donations: ${personAccountLinked} gifts on One-to-One accounts linked to their sole Person; ` +
    `${personAccountRows.length} left without a Donor (see data/review/unlinked-person-account-gifts.csv)`);

  if (personNamed.size > 0) {
    warnings.push(`people: ${personNamed.size} person-named account${personNamed.size === 1 ? '' : 's'} ` +
      `(blank NPSP type, named after its sole Contact) folded into their Contact instead of Organizations`);
  }
  const softCreditTargets = [...softCredits.values()].flat();
  const softCreditUnmigrated = softCreditTargets.filter((id) => !boardOf.has(id)).length;
  warnings.push(`soft credits: ${softCreditTargets.length} on ${softCredits.size} gifts; ` +
    `${softCreditUnmigrated} name a contact who isn't a migrated Person (skipped at load)`);
  const unknown = unknownStages(opportunities);
  if (unknown.size > 0) {
    warnings.push(`donations: ${[...unknown.values()].reduce((a, b) => a + b, 0)} gifts have an unrecognised ` +
      `stage, loaded as Pending — ${[...unknown].map(([stage, n]) => `${stage} (${n})`).join(', ')}`);
  }
  if (feeFold.folded > 0 || feeFold.unpaired > 0) {
    warnings.push(`donations: ${feeFold.folded} Funraise fee-coverage splits folded into their gifts ` +
      `($${(feeFold.foldedCents / 100).toFixed(2)} as Fee Covered); ${feeFold.unpaired} with no matching gift ` +
      `kept as gifts of their own`);
  }
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

  await mkdir(dataPath('review'), { recursive: true });
  // Always written (header-only when nothing needs review), like unaffiliated-org-gifts.csv
  // below — otherwise a file from a prior run with review rows lingers after a later run
  // resolves them all, silently telling the operator there's still something to review.
  await writeFile(dataPath('review', 'email-classification.csv'),
    ['contactSfId,name,email,domain,candidateAffiliations', ...emailReviewRows].join('\n') + '\n', 'utf8');
  await writeFile(dataPath('review', 'unaffiliated-org-gifts.csv'),
    ['opportunitySfId,contactSfId,orgSfId,orgName,amount,closeDate', ...unaffiliatedRows].join('\n') + '\n', 'utf8');
  await writeFile(dataPath('review', 'unlinked-person-account-gifts.csv'),
    ['opportunitySfId,accountSfId,accountName,reason,amount,closeDate', ...personAccountRows].join('\n') + '\n', 'utf8');
  warnings.push(`emails: ${emailStats.work} work, ${emailStats.household} household, ${emailStats.review} review, ` +
    `${emailStats.swapped} swapped` + (emailStats.review > 0 ? ' — see data/review/email-classification.csv' : ''));
  warnings.push(`attribution: ${attributedOpps.size} gifts and ${attributedRegs.size} registrations attributed; ` +
    `${unaffiliatedRows.length} org gifts have no affiliation (see data/review/unaffiliated-org-gifts.csv)`);

  const report: TransformReport = {
    payloadCounts,
    assertions: [
      { name: 'board-ceiling', violations: ceilingViolations },
      { name: 'skipped-links', violations: skippedLinkViolations },
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
