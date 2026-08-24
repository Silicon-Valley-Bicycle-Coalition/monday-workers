export interface StageConfig {
  tag: string;
  offsetDays: number;
}

export interface MondayColumns {
  membershipStatus: string;
  membershipTier: string;
  memberUntil: string;
  remindersSent: string;
  email: string;
}

export interface Config {
  monday: {
    apiUrl: string;
    donorsBoardId: number | null;
    columns: MondayColumns;
  };
  stages: StageConfig[];
  renewalUrl: string;
  timeZone: string;
  lifetimeTierValue: string;
  activeStatusValue: string;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  membershipStatus: string;
  membershipTier: string;
  memberUntil: string; // YYYY-MM-DD
  remindersSent: string; // raw comma-separated stamp text, e.g. "6w:2026-10-01"
}

export interface RunSummary {
  stages: Record<
    string,
    { sent: number; skipped: number; failed: number; stampFailed: number; queryFailed: boolean }
  >;
}
