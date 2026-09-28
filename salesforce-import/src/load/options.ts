import { MAX_BATCH_SIZE } from './batch.js';

/** Load-throughput settings (#22). Config supplies defaults; CLI flags override per run. */
export interface LoadOptions {
  /** create_item mutations per request (1–25). */
  batchSize: number;
  /** Create requests in flight at once (1–8). */
  concurrency: number;
  /** Put board-relation values for already-loaded targets directly into create_item. */
  inlineLinks: boolean;
  /** Pause before a recovery lookup so a just-committed item is visible to search. */
  recoveryLookupDelayMs: number;
}

export type LoadConfig = Partial<LoadOptions>;

const DEFAULTS: LoadOptions = { batchSize: 10, concurrency: 3, inlineLinks: true, recoveryLookupDelayMs: 3000 };
const MAX_CONCURRENCY = 8;

/**
 * Whether these options select the pre-#22 code path exactly (one `create_item` per request,
 * sequential, every link written by the separate link pass) — the cutover-weekend fallback.
 */
export function isLegacySequential(o: LoadOptions): boolean {
  return o.batchSize === 1 && o.concurrency === 1 && !o.inlineLinks;
}

/**
 * Merges `config.load` with `--batch-size N`, `--concurrency N`, `--no-inline-links` and
 * `--sequential` (= `--batch-size 1 --concurrency 1 --no-inline-links`).
 * @returns the options, or an error message for the user.
 */
export function parseLoadOptions(args: string[], cfg: LoadConfig | undefined): LoadOptions | string {
  const o: LoadOptions = { ...DEFAULTS, ...cfg };
  const intIn = (label: string, v: unknown, lo: number, hi: number): string | null =>
    Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? null
      : `load: ${label} must be an integer from ${lo} to ${hi} (got "${String(v ?? '')}")`;
  for (const [label, v, hi] of [['config load.batchSize', o.batchSize, MAX_BATCH_SIZE],
    ['config load.concurrency', o.concurrency, MAX_CONCURRENCY]] as const) {
    const err = intIn(label, v, 1, hi);
    if (err) return err;
  }
  const flag = (name: string, hi: number): number | string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const raw = args[i + 1];
    const n = raw === undefined || raw.startsWith('--') ? NaN : Number(raw);
    return intIn(name, Number.isNaN(n) ? raw : n, 1, hi) ?? n;
  };
  const batch = flag('--batch-size', MAX_BATCH_SIZE);
  if (typeof batch === 'string') return batch;
  if (batch !== undefined) o.batchSize = batch;
  const conc = flag('--concurrency', MAX_CONCURRENCY);
  if (typeof conc === 'string') return conc;
  if (conc !== undefined) o.concurrency = conc;
  if (args.includes('--no-inline-links')) o.inlineLinks = false;
  if (args.includes('--sequential')) Object.assign(o, { batchSize: 1, concurrency: 1, inlineLinks: false });
  return o;
}
