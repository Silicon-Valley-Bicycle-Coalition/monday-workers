export interface ItemPayload {
  board: string;
  sfId: string;
  name: string;
  columns: Record<string, unknown>;
  links?: { column: string; targetSfIds: string[] }[];
}

export interface TransformReport {
  payloadCounts: Record<string, number>;
  assertions: { name: string; violations: string[] }[];
  warnings: string[];
}
