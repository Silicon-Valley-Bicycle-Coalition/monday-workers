// The slice of Node's built-in `node:sqlite` that src/sendGuard.test.ts uses to run the real
// migration and SQL under plain vitest. Declared here rather than pulling in @types/node, which
// would also type the Worker source as if it ran on Node.
declare module 'node:sqlite' {
  interface StatementSync {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
