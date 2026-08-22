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
}

export interface DiscountOrganization {
  name: string;
  discountOffered: string;
}

export interface PortalView {
  donors: DonorPortalData[];
  discounts: DiscountOrganization[];
}

export interface Env {
  DB: D1Database;
  MONDAY_API_TOKEN: string;
  RESEND_API_KEY: string;
  LOGIN_RATE_LIMITER: RateLimit;
}
