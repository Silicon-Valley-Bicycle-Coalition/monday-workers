// Snapshot record shapes. Field names are the snapshot's on-disk format (see SNAPSHOT_FORMAT in
// src/backup.ts) and are read back by the restore tool (src/restore/), so change them only
// together with a format bump.

export interface BoardSummary {
  id: string;
  name: string;
  workspaceId: string | null;
  // Board metadata a restore needs to recreate the board faithfully (issue #30). Optional so a
  // test or an older snapshot can omit them.
  state?: string | null; // active | archived | deleted
  type?: string | null; // board | sub_items_board | document | custom_object
  boardKind?: string | null; // public | private | share
  description?: string | null;
  folderId?: string | null;
  permissions?: string | null;
  itemTerminology?: string | null;
  updatedAt?: string | null;
  // Set only on a sub_items_board found through its parent's subtasks column rather than listed
  // by `boards` — the parent board it belongs to.
  parentBoardId?: string;
}

export interface ColumnDef {
  id: string;
  title: string;
  type: string;
  settingsStr: string;
  description?: string | null;
}

export interface GroupDef {
  id: string;
  title: string;
  color?: string | null;
  position?: string | null;
}

export interface BoardSchema {
  columns: ColumnDef[];
  groups: GroupDef[];
}

export interface ColumnValue {
  id: string;
  type?: string;
  text: string | null;
  value: string | null;
  // Connect-boards and dependency columns: `text`/`value` are null on current API versions, so
  // the linked item ids come from the typed fragment (issue #30).
  linkedItemIds?: string[];
  // Connect-boards, dependency and mirror columns' human-readable value.
  displayValue?: string;
}

// File metadata only — not the bytes. `url` needs a Monday session to open and does not outlive
// the account; see README "What this does not cover" for why file contents are not copied.
export interface AssetRecord {
  id: string;
  name: string;
  fileExtension: string | null;
  fileSize: number | null;
  createdAt: string | null;
  url: string | null;
  uploadedById: string | null;
}

export interface ItemRecord {
  id: string;
  name: string;
  groupId: string | null;
  columnValues: ColumnValue[];
  state?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  creatorId?: string | null;
  // Set on subitems (items of a sub_items_board): the parent item on the main board.
  parentItemId?: string | null;
  assets?: AssetRecord[];
}

export interface UpdateReply {
  id: string;
  body: string;
  textBody: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  creatorId: string | null;
}

// An update (comment) on an item — or on the board itself, when itemId is null.
export interface UpdateRecord {
  id: string;
  itemId: string | null;
  body: string;
  textBody: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  creatorId: string | null;
  replies: UpdateReply[];
  assets: AssetRecord[];
}

export interface DocSummary {
  id: string;
  name: string;
  workspaceId: string | null;
  url: string | null;
  objectId?: string | null;
  docKind?: string | null; // public | private | share
  folderId?: string | null;
  createdAt?: string | null;
}

export interface DocBlock {
  id: string;
  type: string;
  // Monday's JSON scalar, kept exactly as returned (normally a JSON-encoded string).
  content: unknown;
  parentBlockId?: string | null;
  position?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  createdById?: string | null;
}

export interface BackupConfig {
  destinationParentFolderId: string;
  excludeBoardIds: string[];
  // Belt-and-braces alongside the workspace-scoped sandbox token (design doc §4): when set and
  // non-empty, only boards/docs whose workspaceId is in this list are backed up. Absent or
  // empty means no filter — today's "snapshot everything the token can see" behaviour.
  workspaceIds?: string[];
}
