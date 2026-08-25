export interface MondayColumns {
  donorEmail: string;
  membershipStatus: string;
  membershipTier: string;
  dollarDonated: string;
  donationDonorLink: string;
  donationAmount: string;
  donationDate: string;
  donationDescription: string;
  discountOffered: string;
  discountActive: string;
  donorAddress: string;
  donorPhone: string;
  membershipExpiry: string;
}

export interface TaxLetterConfig {
  orgLegalName: string;
  ein: string;
  orgAddress: string;
  signatureName: string;
  signatureTitle: string;
  plainStatement: string;
  benefitStatement: string;
  benefitTiers: string[];
}

export interface ChangeRequestColumns {
  donorLink: string;
  field: string;
  oldValue: string;
  newValue: string;
  submittedAt: string;
}

export interface ChangeRequestsConfig {
  boardId: number | null;
  columns: ChangeRequestColumns;
  dedupeWindowHours: number;
  retentionDays: number;
}

export interface Config {
  monday: {
    apiUrl: string;
    donorsBoardId: number | null;
    donationsBoardId: number | null;
    organizationsBoardId: number | null;
    columns: MondayColumns;
  };
  resend: {
    fromAddress: string;
    fromName: string;
  };
  auth: {
    magicLinkTtlMinutes: number;
    sessionTtlHours: number;
    portalBaseUrl: string;
  };
  rateLimit: {
    emailWindowSeconds: number;
    emailMaxAttempts: number;
  };
  taxLetter: TaxLetterConfig;
  changeRequests: ChangeRequestsConfig;
}

export interface DonorMatch {
  id: string;
  name: string;
}

export interface DonationRecord {
  date: string;
  amount: string;
  description: string;
}

export interface DonorPortalData {
  id: string;
  name: string;
  membershipStatus: string;
  membershipTier: string;
  totalDonated: string;
  donations: DonationRecord[];
  membershipExpiry: string;
}

export interface DiscountOrganization {
  name: string;
  discountOffered: string;
}

export interface DonorContactInfo {
  id: string;
  name: string;
  email: string;
  address: string;
  phone: string;
}

export interface PortalView {
  donors: DonorPortalData[];
  discounts: DiscountOrganization[];
}

// Defined here rather than in changeRequests/submitChangeRequest.ts (which re-exports it for
// that module's own callers) to avoid an import cycle: submitChangeRequest.ts imports
// MondayClient from monday/client.ts, which itself imports from this file.
export interface ChangeQueueMessage {
  requestId: number;
}

// Bindings (DB, queues, rate limiters) come from the generated Cloudflare.Env
// (`npm run typecheck` regenerates worker-configuration.d.ts from wrangler.jsonc);
// only secrets and narrowed queue message types are declared here.
export interface Env extends Cloudflare.Env {
  MONDAY_API_TOKEN: string;
  RESEND_API_KEY: string;
  CHANGE_QUEUE: Queue<ChangeQueueMessage>;
}
