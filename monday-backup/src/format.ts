// Snapshot layout, recorded in every manifest so the restore tool can tell what it is reading.
// v2: one JSON Lines file per board and per doc, streamed page by page (issue #29) — each line is
// a self-describing record `{ type, <type>: payload }` (payloads are nested, never spread, since
// Monday objects carry their own `type` fields); the first line is always the board/doc header.
// Board files: `board` header, then `item` records, then `update` records. Doc files: `doc`
// header, then `block` records in document order.
// v3 (issue #112): the same records, but each file is encrypted before upload and named
// `board-<id>.jsonl.enc` / `doc-<id>.jsonl.enc` (format: src/crypto/snapshotCipher.ts). The
// manifest stays plaintext and records `encryption: { scheme, keyId }`, authenticated by a last
// field, `manifestMac` (HMAC over the JSON before it; src/crypto/snapshotCipher.ts). The restore
// tool reads v2 (only with no key, warning that it is unauthenticated) and v3 (MAC verified first,
// plaintext files refused); an older tool refuses v3 rather than restoring nothing.
export const SNAPSHOT_FORMAT = 'monday-backup/3';
export const READABLE_SNAPSHOT_FORMATS: readonly string[] = ['monday-backup/2', SNAPSHOT_FORMAT];
