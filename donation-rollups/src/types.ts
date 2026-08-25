export interface DonationRollupsConfig {
  monday: {
    apiUrl: string;
    boards: {
      donations: number | null;
      donors: number | null;
      organizations: number | null;
    };
  };
  donationRollups: {
    donationColumns: {
      donorLink: string;
      amount: string;
      date: string;
      fiscalYear: string;
      status: string;
    };
    receivedStatusLabel: string;
    // Donors and Organizations are separate Monday boards with independent column-id
    // namespaces, even for identically-named fields — a shared column-id map would
    // silently write to the wrong (or a nonexistent) column on whichever board isn't
    // "donors".
    ownerColumnsByBoard: {
      donors: OwnerColumns;
      organizations: OwnerColumns;
    };
  };
}

export interface OwnerColumns {
  lifetimeGiving: string;
  giftCount: string;
  firstGift: string;
  thisYearAmount: string;
  thisYearCount: string;
  lastYearAmount: string;
  lastYearCount: string;
  largestGift: string;
  smallestGift: string;
  averageGift: string;
  lastGiftDate: string;
  lastGiftAmount: string;
}

export type PendingStatus = 'received' | 'queued' | 'written' | 'failed';

export interface PendingRow {
  donationItemId: string;
  eventId: string;
  status: PendingStatus;
  ownerItemId: string | null;
  ownerBoard: 'donors' | 'organizations' | null;
  error: string | null;
  receivedAt: string;
  writtenAt: string | null;
}

export interface Env {
  DB: D1Database;
  RECOMPUTE_QUEUE: Queue<RecomputeQueueMessage>;
  MONDAY_API_TOKEN: string;
  MONDAY_WEBHOOK_SECRET?: string;
}

export interface RecomputeQueueMessage {
  donationItemId: string;
}
