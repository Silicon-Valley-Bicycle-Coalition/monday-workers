import { describe, expect, it } from 'vitest';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';

// Issue GL#29: a 100ms cpu_ms cap killed every nightly run mid-snapshot. A CPU-limit kill is not an
// exception — the `catch` in runSnapshot never runs, the D1 row stays `running`, and nobody is
// alerted. A full-account snapshot parses and stringifies megabytes of JSON and RS256-signs a JWT,
// so the cap has to be in minutes, not milliseconds. 300,000ms (5 min) is the documented maximum
// `cpu_ms` accepts (developers.cloudflare.com/workers/wrangler/configuration/#limits). Wall time
// isn't a limit here: the snapshot runs as a Workflow, whose steps have none.

type Json = Record<string, unknown>;
const wrangler = parseJsonc(wranglerText) as Json;
const sandbox = (wrangler.env as Json).sandbox as Json;

const MIN_CPU_MS = 60_000;
const MAX_CPU_MS = 300_000;

describe.each([
  ['production', wrangler],
  ['sandbox', sandbox],
])('wrangler.jsonc limits (%s)', (_name, block) => {
  const limits = block.limits as { cpu_ms?: number; subrequests?: number };

  it('allows minutes of CPU, within the configurable maximum', () => {
    expect(limits.cpu_ms).toBeGreaterThanOrEqual(MIN_CPU_MS);
    expect(limits.cpu_ms).toBeLessThanOrEqual(MAX_CPU_MS);
  });

  it('raises the subrequest cap above the 10,000 default (one per Monday page, Drive chunk, and D1 call)', () => {
    expect(limits.subrequests).toBeGreaterThan(10_000);
  });
});
