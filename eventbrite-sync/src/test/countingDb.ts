// Wraps a D1 binding and counts prepare() calls, so a test can pin how many statements a store
// method issues (GL#101: the webhook path's upserts are one statement each).
export function countingDb(db: D1Database): { db: D1Database; prepared: () => number } {
  let count = 0;
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          count++;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: wrapped, prepared: () => count };
}
