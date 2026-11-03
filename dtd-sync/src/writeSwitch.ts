// dtd-sync's side of the write switch (src/flags.ts): the dry-run versions of the three things the
// jobs write to. A dry run reads DTD, Monday and D1 exactly as a live run does; only the writes are
// swapped for a skip line (logSkip) here.
//
//   Monday  - updateDonation / updatePerson / upsertProgramSummary (recordingProxy)
//   DTD     - registerDonation (recordingProxy)
//   D1      - every statement that isn't a SELECT (dryRunDb)
//
// A dry run never advances the watermark or records pushes, so each dry-run hour re-reads the same window.
import { logSkip, recordingProxy, type SkipContext } from './flags';
import type { DtdClient } from './dtd/client';
import type { DtdMondayClient } from './monday/client';

export type DryRunnableDtd = Pick<DtdClient, 'getUpdatedDonations' | 'registerDonation'>;

const noop = async (): Promise<void> => undefined;

export function dryRunMonday(monday: DtdMondayClient, ctx: SkipContext): DtdMondayClient {
  return recordingProxy(monday, 'Monday', { updateDonation: noop, updatePerson: noop, upsertProgramSummary: noop }, ctx);
}

export function dryRunDtd(dtd: DryRunnableDtd, ctx: SkipContext): DryRunnableDtd {
  return recordingProxy(dtd, 'DTD', { registerDonation: noop }, ctx);
}

const SELECT = /^\s*select\b/i;

function emptyResult(): D1Result<never> {
  return { success: true, results: [], meta: {} } as unknown as D1Result<never>;
}

/** A statement that logs instead of writing. Its bound values never reach the log at normal level. */
function writeStub(sql: string, ctx: SkipContext): D1PreparedStatement {
  const operation = sql.trim().split(/\s+/)[0]?.toUpperCase() || 'SQL';
  let bound: unknown[] = [];
  const skip = () => logSkip(ctx, 'D1', operation, bound);
  const stub = {
    bind(...values: unknown[]) {
      bound = values;
      return stub;
    },
    async run() { skip(); return emptyResult(); },
    async all() { skip(); return emptyResult(); },
    async first() { skip(); return null; },
    async raw() { skip(); return []; },
  };
  return stub as unknown as D1PreparedStatement;
}

type Statements = Pick<D1Database, 'prepare' | 'batch'>;

function wrapStatements<T extends Statements>(db: T, ctx: SkipContext, extra: (target: T, prop: string | symbol) => unknown): T {
  const stubs = new WeakSet<object>();
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (SELECT.test(sql)) return target.prepare(sql);
          const stub = writeStub(sql, ctx);
          stubs.add(stub);
          return stub;
        };
      }
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const results: D1Result<unknown>[] = [];
          for (const statement of statements) {
            results.push(stubs.has(statement) ? ((await statement.run()) as D1Result<unknown>) : await statement.all());
          }
          return results;
        };
      }
      const handled = extra(target, prop);
      if (handled !== undefined) return handled;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: never[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * The database with every non-SELECT statement dropped. SELECTs run against the real database, so
 * the jobs still read what a live run would; INSERT/UPDATE/DELETE resolve an empty success result
 * and log a skip line. exec is logged and dropped, withSession returns a wrapped session, and dump
 * is refused, so no path reaches a write. The job code is unchanged, which keeps the stores plain
 * module functions.
 */
export function dryRunDb(db: D1Database, ctx: SkipContext): D1Database {
  return wrapStatements(db, ctx, (target, prop) => {
    if (prop === 'exec') {
      return async (sql: string) => {
        logSkip(ctx, 'D1', 'exec', [sql]);
        return { count: 0, duration: 0 };
      };
    }
    if (prop === 'withSession') {
      return (constraint?: D1SessionBookmark | D1SessionConstraint) =>
        wrapStatements(target.withSession(constraint), ctx, () => undefined);
    }
    if (prop === 'dump') {
      return async () => { throw new Error('dtd-sync: D1 dump is not available in a dry run'); };
    }
    return undefined;
  });
}
