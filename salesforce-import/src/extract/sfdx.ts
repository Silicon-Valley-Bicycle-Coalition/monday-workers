import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = async (cmd, args) =>
  promisify(execFile)(cmd, args, { maxBuffer: 1024 * 1024 * 1024 });

export async function runSoql(
  org: string,
  soql: string,
  opts: { exec?: ExecFn } = {},
): Promise<Record<string, unknown>[]> {
  const exec = opts.exec ?? defaultExec;
  const { stdout } = await exec('sf', ['data', 'query', '--target-org', org, '-q', soql, '--json']);
  const parsed = JSON.parse(stdout) as {
    status: number; message?: string; result?: { records: Record<string, unknown>[] };
  };
  if (parsed.status !== 0 || !parsed.result) {
    throw new Error(`sf data query failed: ${parsed.message ?? 'unknown error'}`);
  }
  return parsed.result.records.map(({ attributes: _a, ...rest }) => rest);
}

// The sf CLI silently truncates result sets at 50,000 rows (done:false, no error — see the
// planning repo's docs/10). For objects that can exceed that, keyset-paginate on Id. The base
// SOQL must not contain WHERE/ORDER BY/LIMIT — this appends its own.
export const CLI_ROW_CEILING = 50_000;

export async function runSoqlPaginated(
  org: string,
  soql: string,
  opts: { exec?: ExecFn; pageSize?: number } = {},
): Promise<Record<string, unknown>[]> {
  if (/\b(WHERE|ORDER BY|LIMIT)\b/i.test(soql)) {
    throw new Error('runSoqlPaginated: base SOQL must not contain WHERE/ORDER BY/LIMIT');
  }
  const pageSize = opts.pageSize ?? CLI_ROW_CEILING;
  const out: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await runSoql(org,
      `${soql}${cursor ? ` WHERE Id > '${cursor}'` : ''} ORDER BY Id LIMIT ${pageSize}`,
      { exec: opts.exec });
    out.push(...page);
    if (page.length < pageSize) return out;
    cursor = page[page.length - 1]!['Id'] as string;
  }
}
