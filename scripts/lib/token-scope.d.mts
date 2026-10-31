export interface ScopeBoard {
  id?: string;
  workspace_id?: string | number | null;
  board_kind?: string;
  permissions?: string;
  state?: string;
}
export interface ScopeSummary {
  total: number;
  inside: number;
  outside: {
    boards: number;
    editableByEveryone: number;
    byKind: Record<string, number>;
    byState: Record<string, number>;
    workspaces: { workspaceId: string; boards: number; editableByEveryone: number; notActive: number }[];
  };
}
export function summarizeScope(boards: ScopeBoard[], allowedWorkspaceIds: (string | number)[]): ScopeSummary;
export function listBoards(queryFn: (graphql: string) => Promise<{ boards: ScopeBoard[] }>): Promise<ScopeBoard[]>;
