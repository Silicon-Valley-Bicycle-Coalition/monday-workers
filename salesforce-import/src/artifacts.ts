import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Everything under data/ is donor PII (extracts, the ledger, the geocode cache, review sheets),
// so it's owner-only regardless of umask (#111). `mode` on mkdir/open only applies when the
// path is created, so full rewrites and ensureDir also chmod, tightening a tree an older build
// left 0755/0644.
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

export function dataPath(...segments: string[]): string {
  return resolve(process.cwd(), 'data', ...segments);
}

async function ensureDir(path: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
  await chmod(dir, PRIVATE_DIR);
}

export async function writeNdjson(path: string, rows: Iterable<unknown>): Promise<number> {
  await ensureDir(path);
  const out = createWriteStream(path, { encoding: 'utf8', mode: PRIVATE_FILE });
  let n = 0;
  for (const row of rows) { out.write(JSON.stringify(row) + '\n'); n++; }
  await new Promise<void>((res, rej) => out.end((e: unknown) => (e ? rej(e) : res())));
  await chmod(path, PRIVATE_FILE);
  return n;
}

export async function readNdjson<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}

// A crash mid-append can leave an append-only NDJSON file ending in a partial line. Left in
// place it makes readNdjson throw, and the next append would glue a valid row onto it. Truncate
// a torn final line (no trailing newline) back to the last complete row; a bad line anywhere
// else is real corruption and still throws from readNdjson. Returns the dropped fragment.
export async function repairTornTail(path: string): Promise<string | null> {
  const raw = await readFile(path, 'utf8');
  if (raw === '' || raw.endsWith('\n')) return null;
  const cut = raw.lastIndexOf('\n') + 1;
  const tail = raw.slice(cut);
  try { JSON.parse(tail); } catch {
    await writeFile(path, raw.slice(0, cut), { encoding: 'utf8', mode: PRIVATE_FILE });
    return tail;
  }
  // A complete row that only lacks its newline — keep it, just terminate it.
  await appendFile(path, '\n', { encoding: 'utf8', mode: PRIVATE_FILE });
  return null;
}

// Per-row append (the ledger): mode covers a new file; ensureDir's chmod on the directory
// covers an old 0644 file without a chmod per row.
export async function appendNdjson(path: string, row: unknown): Promise<void> {
  await ensureDir(path);
  await appendFile(path, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: PRIVATE_FILE });
}

/** Writes a whole text file (CSV, Markdown report) owner-only, creating its directory 0700. */
export async function writeText(path: string, text: string): Promise<void> {
  await ensureDir(path);
  await writeFile(path, text, { encoding: 'utf8', mode: PRIVATE_FILE });
  await chmod(path, PRIVATE_FILE);
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value, null, 2) + '\n');
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
