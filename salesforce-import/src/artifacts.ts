import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function dataPath(...segments: string[]): string {
  return resolve(process.cwd(), 'data', ...segments);
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export async function writeNdjson(path: string, rows: Iterable<unknown>): Promise<number> {
  await ensureDir(path);
  const out = createWriteStream(path, 'utf8');
  let n = 0;
  for (const row of rows) { out.write(JSON.stringify(row) + '\n'); n++; }
  await new Promise<void>((res, rej) => out.end((e: unknown) => (e ? rej(e) : res())));
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
    await writeFile(path, raw.slice(0, cut), 'utf8');
    return tail;
  }
  // A complete row that only lacks its newline — keep it, just terminate it.
  await appendFile(path, '\n', 'utf8');
  return null;
}

export async function appendNdjson(path: string, row: unknown): Promise<void> {
  await ensureDir(path);
  await appendFile(path, JSON.stringify(row) + '\n', 'utf8');
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDir(path);
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
