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
