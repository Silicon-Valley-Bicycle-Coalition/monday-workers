import type { MondayClient } from '../monday/client';
import type { ChangeRequestStore } from '../db/changeRequests';
import type { ChangeQueueMessage, DonationRecord } from '../types';
import { findTestPersona, findTestPersonasByEmail, isTestDonorId } from './personas';

// Wraps the real Monday client so a test-account id (see personas.ts) reads its dummy persona and
// every other id goes to Monday unchanged. Only ever wired in the sandbox and the local preview
// (src/index.ts, src/index.local.ts), never in production.

function totalDonated(donations: DonationRecord[]): string {
  const cents = donations.reduce((sum, d) => sum + Math.round(Number(d.amount) * 100), 0);
  return (cents / 100).toFixed(2);
}

export function withTestAccounts(real: MondayClient, now: () => Date): MondayClient {
  const persona = (id: string) => findTestPersona(id, now());
  // Spread copies every method, so writes and cron-only reads (letter settings, the year-end
  // sweeps, volunteer hours, change-request items) stay the real client's: no test id reaches
  // them. Personas have no affiliations or organizations, so the org reads below answer empty for
  // a test id and pass every other id through.
  return {
    ...bindAll(real),
    async findDonorsByEmail(email) {
      const matches = findTestPersonasByEmail(email, now());
      // The sign-in address sits in Personal Email except for the shared-inbox household.
      if (matches.length > 0) {
        return matches.map((p) => ({ id: p.id, name: p.name, preferredLanguage: p.preferredLanguage, matchedPersonal: !p.sharedInbox }));
      }
      return real.findDonorsByEmail(email);
    },
    async getMemberPortalData(donorItemId, options = {}) {
      if (!isTestDonorId(donorItemId)) return real.getMemberPortalData(donorItemId, options);
      const p = persona(donorItemId);
      const includeDonations = options.includeDonations ?? true;
      return {
        id: p.id,
        name: p.name,
        membershipStatus: p.membershipStatus,
        membershipTier: p.membershipTier,
        totalDonated: includeDonations ? totalDonated(p.donations) : '',
        donations: includeDonations ? p.donations : [],
        membershipExpiry: p.membershipExpiry,
        memberSince: p.memberSince,
        memberType: p.memberType,
      };
    },
    async getVolunteerShiftsForDonor(donorItemId) {
      if (!isTestDonorId(donorItemId)) return real.getVolunteerShiftsForDonor(donorItemId);
      return persona(donorItemId).volunteerShifts;
    },
    async getDonorContactInfo(donorItemId) {
      if (!isTestDonorId(donorItemId)) return real.getDonorContactInfo(donorItemId);
      const p = persona(donorItemId);
      return {
        id: p.id,
        name: p.name,
        email: p.email,
        address: p.address,
        phone: p.phone,
        preferredLanguage: p.preferredLanguage,
        employer: p.employer,
        emailOptOut: false,
        smsOptOut: false,
        doNotMail: false,
      };
    },
    // The sign-in address in its column, so the info door shows it (and only it): Personal Email,
    // or the Household Email for the shared-inbox household.
    async getDonorEmails(donorItemId) {
      if (!isTestDonorId(donorItemId)) return real.getDonorEmails(donorItemId);
      const p = persona(donorItemId);
      return {
        personal: p.sharedInbox ? '' : p.email,
        household: p.sharedInbox ? p.email : '',
        personalConsent: '',
        householdConsent: '',
      };
    },
    async getDonorNames(donorItemIds) {
      const realIds = donorItemIds.filter((id) => !isTestDonorId(id));
      const realNames = realIds.length > 0 ? await real.getDonorNames(realIds) : [];
      const byId = new Map(realNames.map((n) => [n.id, n]));
      return donorItemIds.flatMap((id) => {
        if (isTestDonorId(id)) return [{ id, name: persona(id).name }];
        const found = byId.get(id);
        return found === undefined ? [] : [found];
      });
    },
    async getPledgesForDonor(donorItemId) {
      return isTestDonorId(donorItemId) ? [] : real.getPledgesForDonor(donorItemId);
    },
    async getEventRegistrationsForDonor(params) {
      return isTestDonorId(params.donorItemId) ? [] : real.getEventRegistrationsForDonor(params);
    },
    async getPersonAffiliations(params) {
      return isTestDonorId(params.donorItemId) ? [] : real.getPersonAffiliations(params);
    },
    async findAffiliationsByWorkEmail(email) {
      return findTestPersonasByEmail(email, now()).length > 0 ? [] : real.findAffiliationsByWorkEmail(email);
    },
    async getAffiliation(affiliationItemId) {
      return isTestDonorId(affiliationItemId) ? null : real.getAffiliation(affiliationItemId);
    },
    async getOrganizationAffiliations(orgItemId) {
      return isTestDonorId(orgItemId) ? [] : real.getOrganizationAffiliations(orgItemId);
    },
    async getOrganization(orgItemId) {
      return isTestDonorId(orgItemId) ? null : real.getOrganization(orgItemId);
    },
    async getOrganizationGifts(orgItemId) {
      return isTestDonorId(orgItemId) ? [] : real.getOrganizationGifts(orgItemId);
    },
    async getOrganizationMatches(orgItemId) {
      return isTestDonorId(orgItemId) ? [] : real.getOrganizationMatches(orgItemId);
    },
  };
}

// Object spread skips class prototype methods, so copy each one bound to the instance.
function bindAll(real: MondayClient): MondayClient {
  const out: Record<string, unknown> = {};
  let proto: object | null = real;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      const value = (real as unknown as Record<string, unknown>)[key];
      if (key !== 'constructor' && typeof value === 'function' && !(key in out)) {
        out[key] = (value as (...args: unknown[]) => unknown).bind(real);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return out as unknown as MondayClient;
}

export function isTestSession(donorItemIds: string[]): boolean {
  return donorItemIds.length > 0 && donorItemIds.every(isTestDonorId);
}

// A test account's change request goes through every check a real one does, then lands here:
// nothing in D1, nothing on the queue, so nothing reaches the Change Requests board and the same
// change can be submitted again on the next try.
export const discardingChangeStore: ChangeRequestStore = {
  createRequest: async () => 0,
  hasRecentDuplicate: async () => false,
  findRecentByDedupeHash: async () => null,
  getRequest: async () => null,
  markWritten: async () => {},
  purgeWrittenBefore: async () => 0,
};

export const discardingChangeQueue = { send: async (_message: ChangeQueueMessage) => {} };
