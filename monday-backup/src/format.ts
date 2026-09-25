// Snapshot layout, recorded in every manifest so the restore tool can tell what it is reading.
// v2: one JSON Lines file per board and per doc, streamed page by page (issue #29) — each line is
// a self-describing record `{ type, <type>: payload }` (payloads are nested, never spread, since
// Monday objects carry their own `type` fields); the first line is always the board/doc header.
// Board files: `board` header, then `item` records, then `update` records. Doc files: `doc`
// header, then `block` records in document order.
export const SNAPSHOT_FORMAT = 'monday-backup/2';
