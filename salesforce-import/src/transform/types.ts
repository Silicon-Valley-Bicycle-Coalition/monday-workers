export interface ItemPayload {
  board: string;
  sfId: string;
  name: string;
  columns: Record<string, unknown>;
  links?: { column: string; targetSfIds: string[] }[];
  // Donations only: load archives this item in place after its links land (transform/schedule.ts).
  archive?: boolean;
}

export interface TransformReport {
  payloadCounts: Record<string, number>;
  assertions: { name: string; violations: string[] }[];
  warnings: string[];
}
