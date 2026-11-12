import { describe, expect, it } from 'vitest';
import { checkTarget, parseRestoreArgs } from './args';
import type { Snapshot } from './snapshot';

const today = new Date('2026-09-25T12:00:00Z');

describe('parseRestoreArgs', () => {
  it('defaults to a dry run with a dated suffix and a ledger inside the snapshot folder', () => {
    expect(parseRestoreArgs(['snap/2026-09-24 run-7/', '--workspace', '17141226'], today)).toEqual({
      snapshotDir: 'snap/2026-09-24 run-7',
      workspaceId: '17141226',
      execute: false,
      boardIds: undefined,
      docIds: undefined,
      nameSuffix: ' (restored 2026-09-25)',
      ledgerPath: 'snap/2026-09-24 run-7/restore-ledger.jsonl',
      intoSourceWorkspace: false,
      keyFile: undefined,
    });
  });

  it('parses every option', () => {
    const args = parseRestoreArgs(
      ['dir', '--workspace', '5', '--execute', '--boards', '10, 11', '--docs', 'none', '--suffix', ' [drill]', '--ledger', '/tmp/l.jsonl', '--into-source-workspace', '--key-file', '/keys/backup.key'],
      today,
    );
    expect(args).toMatchObject({
      execute: true,
      boardIds: ['10', '11'],
      docIds: [],
      nameSuffix: ' [drill]',
      ledgerPath: '/tmp/l.jsonl',
      intoSourceWorkspace: true,
      keyFile: '/keys/backup.key',
    });
  });

  it.each([
    [[], /exactly one snapshot directory/],
    [['dir'], /--workspace <numeric id> is required/],
    [['dir', '--workspace', 'abc'], /--workspace <numeric id> is required/],
    [['dir', '--workspace'], /--workspace needs a value/],
    [['dir', '--workspace', '5', '--force', 'x'], /unknown option --force/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseRestoreArgs(argv, today)).toThrow(message);
  });
});

describe('checkTarget', () => {
  const snapshot: Snapshot = {
    manifest: { format: 'monday-backup/2' },
    boards: [{ board: { id: '10', name: 'Donors', workspaceId: '111' }, schema: { columns: [], groups: [] }, items: [], updates: [] }],
    docs: [{ doc: { id: 'd1', name: 'Runbook', workspaceId: '111', url: null }, blocks: [] }],
    warnings: [],
  };
  const args = (extra: Record<string, unknown> = {}) => ({ ...parseRestoreArgs(['dir', '--workspace', '222'], today), ...extra });

  it('accepts an unrelated target workspace', () => {
    expect(() => checkTarget(snapshot, args())).not.toThrow();
  });

  it('refuses the workspace the snapshot came from unless explicitly allowed', () => {
    expect(() => checkTarget(snapshot, args({ workspaceId: '111' }))).toThrow(/where this snapshot was taken from/);
    expect(() => checkTarget(snapshot, args({ workspaceId: '111', intoSourceWorkspace: true }))).not.toThrow();
  });

  it('refuses an empty name suffix', () => {
    expect(() => checkTarget(snapshot, args({ nameSuffix: '' }))).toThrow(/suffix/);
  });

  it('refuses board or doc ids that are not in the snapshot', () => {
    expect(() => checkTarget(snapshot, args({ boardIds: ['10', '99'] }))).toThrow(/--boards: not in this snapshot: 99/);
    expect(() => checkTarget(snapshot, args({ docIds: ['d9'] }))).toThrow(/--docs: not in this snapshot: d9/);
  });
});
