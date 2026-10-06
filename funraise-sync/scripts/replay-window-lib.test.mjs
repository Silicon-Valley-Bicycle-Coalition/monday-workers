import { describe, it, expect } from 'vitest';
import { selectWindowSql, classifyReplayResponse, planRedrive, TEST_TRANSACTION_ID } from './replay-window-lib.mjs';

describe('selectWindowSql', () => {
  it('selects by time whatever the status, so rows the sandbox already wrote are included', () => {
    const sql = selectWindowSql('2026-10-09T17:30:00.000Z');
    expect(sql).toContain("received_at >= '2026-10-09T17:30:00.000Z'");
    expect(sql).not.toMatch(/status\s+(IN|=)/i);
    expect(sql).toContain("entity_type = 'transaction'");
    expect(sql).toMatch(/ORDER BY received_at, entity_id$/);
  });

  it("never selects Funraise's Test-button transaction", () => {
    expect(selectWindowSql('2026-10-09T17:30:00.000Z')).toContain(`entity_id != '${TEST_TRANSACTION_ID}'`);
  });

  it('adds an exclusive upper bound when given', () => {
    const sql = selectWindowSql('2026-10-09T17:30:00.000Z', '2026-10-10T20:00:00.000Z');
    expect(sql).toContain("received_at < '2026-10-10T20:00:00.000Z'");
  });

  it.each(['', 'yesterday', "2026-10-09T17:30:00.000Z'; DROP TABLE events; --", '2026-10-09', null, 12])(
    'rejects a malformed --since (%s) before it reaches wrangler',
    (bad) => {
      expect(() => selectWindowSql(bad)).toThrow(/--since/);
    }
  );

  it('rejects a malformed --until', () => {
    expect(() => selectWindowSql('2026-10-09T17:30:00.000Z', "x' OR 1=1 --")).toThrow(/--until/);
  });
});

describe('classifyReplayResponse', () => {
  it('treats a fresh accepted delivery as enqueued', () => {
    expect(classifyReplayResponse(200, '{"ok":true}')).toBe('enqueued');
  });

  it('treats a duplicate as success: replays are idempotent and the stale-delivery guard answers it', () => {
    expect(classifyReplayResponse(200, '{"ok":true,"duplicate":true}')).toBe('duplicate');
  });

  it('stops on a bad secret instead of failing every delivery in turn', () => {
    expect(classifyReplayResponse(401, '{"ok":false}')).toBe('auth');
  });

  it.each([
    [500, '{"ok":false}'],
    [200, '{"ok":false,"error":"missing id"}'],
    [200, 'not json'],
    [200, ''],
    [502, '<html>bad gateway</html>'],
  ])('treats HTTP %s %j as a failure', (status, body) => {
    expect(classifyReplayResponse(status, body)).toBe('failed');
  });
});

describe('planRedrive as used by the replay', () => {
  it('replays a written row and keeps its original sentAt so the stale-delivery guard still works', () => {
    const { deliveries, unreplayable } = planRedrive([
      {
        entity_id: '123',
        sent_at: 1790000000000,
        raw_payload: JSON.stringify({ id: 123, transaction: { amount: 10 } }),
        status: 'written',
        error: null,
        received_at: '2026-10-09T18:00:00.000Z',
      },
    ]);
    expect(unreplayable).toEqual([]);
    expect(deliveries[0].envelope).toEqual({ event: 'DONATION', sentAt: 1790000000000, data: { id: 123, transaction: { amount: 10 } } });
  });

  it('reports a row whose payload the retention purge emptied instead of replaying nothing', () => {
    const { deliveries, unreplayable } = planRedrive([
      { entity_id: '9', sent_at: 1, raw_payload: '{}', status: 'written', error: null, received_at: '2026-10-09T18:00:00.000Z' },
    ]);
    expect(deliveries).toEqual([]);
    expect(unreplayable).toEqual([{ entityId: '9', reason: 'raw_payload purged or unparseable' }]);
  });
});
