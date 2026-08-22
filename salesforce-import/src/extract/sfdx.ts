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
