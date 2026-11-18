import { MAX_BATCH_SIZE } from './batch.js';

/** Load-throughput settings (GL#22). Config supplies defaults; CLI flags override per run. */
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

// The default is the pre-#22 sequential path until the batched path passes its sandbox
// rehearsal (README) — nobody gets batching by accident.
const DEFAULTS: LoadOptions = { batchSize: 1, concurrency: 1, inlineLinks: false, recoveryLookupDelayMs: 3000 };
/** What `--batched` turns on: the recommended batched settings. */
export const BATCHED_PRESET = { batchSize: 10, concurrency: 3, inlineLinks: true } as const;
const MAX_CONCURRENCY = 8;

/**
 * Whether these options select the pre-#22 code path exactly (one `create_item` per request,
 * sequential, every link written by the separate link pass) — the cutover-weekend fallback.
 */
export function isLegacySequential(o: LoadOptions): boolean {
  return o.batchSize === 1 && o.concurrency === 1 && !o.inlineLinks;
}

/** One line naming the mode a run uses, printed at the start of `load`. */
export function describeMode(o: LoadOptions): string {
  return isLegacySequential(o) ? 'load: mode = sequential (default)'
    : `load: mode = batched (size ${o.batchSize}, concurrency ${o.concurrency}, ` +
      `inline links ${o.inlineLinks ? 'on' : 'off'})`;
}

/**
 * Merges `config.load` (default: sequential) with `--batched` (the recommended batched
 * settings, {@link BATCHED_PRESET}), then `--batch-size N`, `--concurrency N` and
 * `--no-inline-links` on top. `--sequential` (= the default, `--batch-size 1 --concurrency 1
 * --no-inline-links`) wins last. Anything but that exact combination runs batched.
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
  if (typeof o.inlineLinks !== 'boolean') {
    return `load: config load.inlineLinks must be true or false (got ${JSON.stringify(o.inlineLinks)})`;
  }
  if (typeof o.recoveryLookupDelayMs !== 'number' || !Number.isFinite(o.recoveryLookupDelayMs) ||
    o.recoveryLookupDelayMs < 0) {
    return `load: config load.recoveryLookupDelayMs must be a non-negative number of ms ` +
      `(got ${JSON.stringify(o.recoveryLookupDelayMs)})`;
  }
  if (args.includes('--batched') && args.includes('--sequential')) {
    return 'load: --batched and --sequential are mutually exclusive';
  }
  if (args.includes('--batched')) Object.assign(o, BATCHED_PRESET);
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
